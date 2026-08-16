(function(){
  'use strict';

  const LOCAL_AREA_URL='data/delivery-areas.geojson?v=20260814-3';
  const KEY_STORAGE='melbourne-delivery-google-maps-key';
  const legacyCode=document.getElementById('legacyLeafletCode')?.textContent||'';

  function legacyJson(name){
    const match=legacyCode.match(new RegExp(`const\\s+${name}=([^;]+);`));
    if(!match) throw new Error(`Missing legacy configuration: ${name}`);
    return JSON.parse(match[1]);
  }

  const zoneByPostcode=legacyJson('zoneByPostcode');
  const postcodeBatches=legacyJson('postcodeBatches');
  const localityZones={'ELTHAM':'Standard','ELTHAM NORTH':'Standard','RESEARCH':'Additional charge'};
  const directSuburbMarkerOverrides={
    MELBOURNE:{lat:-37.8136,lng:144.9631}
  };
  const staticMode=new URLSearchParams(location.search).has('static');
  const layoutEditMode=new URLSearchParams(location.search).has('layout-edit');
  // The published site should use the cloud-styled, road-shield-free map by
  // default. `?road-icons=default` remains available for comparison/testing.
  const roadIconMode=new URLSearchParams(location.search).get('road-icons')||'custom';
  const cloudMapId=String(window.GOOGLE_MAPS_MAP_ID||'').trim();

  const statusElement=document.getElementById('status');
  const searchPanel=document.getElementById('searchPanel');
  const panelToggle=document.getElementById('panelToggle');
  const searchInput=document.getElementById('searchInput');
  const inputCount=document.getElementById('inputCount');
  const searchButton=document.getElementById('searchButton');
  const clearButton=document.getElementById('clearButton');
  const boundaryToggleButton=document.getElementById('boundaryToggleButton');
  const boundaryToggleLabel=document.getElementById('boundaryToggleLabel');
  const suburbTagToggleButton=document.getElementById('suburbTagToggleButton');
  const suburbTagToggleLabel=document.getElementById('suburbTagToggleLabel');
  const resultMarkButton=document.getElementById('resultMarkButton');
  const resultMarkLabel=document.getElementById('resultMarkLabel');
  const sheetImportButton=document.getElementById('sheetImportButton');
  const sheetImportLabel=document.getElementById('sheetImportLabel');
  const searchResults=document.getElementById('searchResults');
  const searchProgress=document.getElementById('searchProgress');
  const searchProgressBar=searchProgress.querySelector('span');
  const legendElement=document.getElementById('legend');

  const selectedSuburbs=new Map();
  const selectedPostcodes=new Set();
  const suburbFeatures=new Map();
  const suburbZoneByName=new Map();
  const postcodeSuburbs=new Map();
  const sessionGeocodeCache=new Map();
  const addressMarkers=[];
  const directSuburbNames=new Set();
  const suburbSearchMarkers=new Map();
  const postcodeLabels=new Map();
  const postcodeGroupColors={1:'#2563EB',2:'#16A34A',3:'#F59E0B',4:'#9333EA'};

  let map=null;
  let viewportReady=false;
  let geocoder=null;
  let infoWindow=null;
  let AdvancedMarkerElement=null;
  let markerProjection=null;
  let defaultData=null;
  let suburbData=null;
  let defaultBounds=null;
  let areaLoadPromise=null;
  let suburbLoadPromise=null;
  let preciseScaleControl=null;
  let searchActive=false;
  let boundariesVisible=false;
  let suburbTagsVisible=true;
  let infoOpen=false;
  let sheetsTokenClient=null;
  let sheetsAccessToken='';
  let sheetsTokenResolve=null;
  let sheetsTokenReject=null;
  let queuedSystemShipmentPayload=null;

  const SHEETS_READ_SCOPE='https://www.googleapis.com/auth/spreadsheets.readonly';

  searchButton.disabled=true;
  clearButton.disabled=true;
  if(boundaryToggleButton) boundaryToggleButton.disabled=true;
  if(staticMode) document.body.classList.add('static-map');

  function parseSearchItems(value){
    return String(value||'')
      .split(/\r?\n/)
      .flatMap(rawLine=>{
        const line=rawLine.trim();
        if(!line) return [];
        const postcodeCandidates=line.split(/[\s,;，；、]+/).filter(Boolean);
        const isPostcodeList=postcodeCandidates.length>0&&
          postcodeCandidates.every(candidate=>/^3\d{3}$/.test(candidate));
        return isPostcodeList?postcodeCandidates:[line];
      });
  }

  function updateInputCount(){
    const count=parseSearchItems(searchInput.value).length;
    inputCount.textContent=`${count} ${count===1?'entry':'entries'}`;
  }

  function importShipmentsFromSystem(payload){
    const addresses=[...new Set(
      (Array.isArray(payload?.shipments)?payload.shipments:[])
        .map(shipment=>String(shipment?.address||'').trim())
        .filter(Boolean)
    )];
    if(!addresses.length) return;

    searchInput.value=addresses.join('\n');
    updateInputCount();
    searchPanel.classList.remove('collapsed');
    panelToggle.textContent='−';
    panelToggle.title='Collapse';

    if(payload.autoSearch===false) return;
    if(searchButton.disabled){
      queuedSystemShipmentPayload=payload;
      return;
    }

    queuedSystemShipmentPayload=null;
    runBatchSearch();
  }

  window.addEventListener('message',event=>{
    if(event.source!==window.parent) return;
    if(event.data?.type==='BENTWAY_MAP_VISIBLE'){
      repairMapViewport();
      return;
    }
    if(event.data?.type!=='BENTWAY_SHOW_SHIPMENTS') return;
    importShipmentsFromSystem(event.data);
  });

  function repairMapViewport(){
    if(!map||viewportReady||!map.getDiv().offsetWidth||!map.getDiv().offsetHeight) return;
    viewportReady=true;
    google.maps.event.trigger(map,'resize');
    requestAnimationFrame(()=>{
      if(searchActive) fitSearchResults();
      else if(defaultBounds&&!defaultBounds.isEmpty()) map.fitBounds(defaultBounds,35);
    });
  }

  function sheetImportConfig(){
    const raw=window.GOOGLE_SHEETS_IMPORT_CONFIG||{};
    const spreadsheetInput=String(raw.spreadsheetId||'').trim();
    const urlMatch=spreadsheetInput.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    return {
      oauthClientId:String(raw.oauthClientId||'').trim(),
      spreadsheetId:urlMatch?.[1]||spreadsheetInput,
      range:String(raw.range||'').trim()
    };
  }

  function missingSheetImportConfig(config){
    const missing=[];
    if(!config.oauthClientId) missing.push('Google OAuth Client ID');
    if(!config.spreadsheetId) missing.push('Google Sheet link or Spreadsheet ID');
    if(!config.range) missing.push('sheet name and address range');
    return missing;
  }

  function waitForGoogleIdentityServices(timeoutMs=8000){
    if(window.google?.accounts?.oauth2) return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const started=Date.now();
      const timer=setInterval(()=>{
        if(window.google?.accounts?.oauth2){
          clearInterval(timer);
          resolve();
        }else if(Date.now()-started>=timeoutMs){
          clearInterval(timer);
          reject(new Error('Google sign-in failed to load. Check the network and refresh the page.'));
        }
      },100);
    });
  }

  function initialiseSheetsTokenClient(config){
    if(sheetsTokenClient) return sheetsTokenClient;
    sheetsTokenClient=google.accounts.oauth2.initTokenClient({
      client_id:config.oauthClientId,
      scope:SHEETS_READ_SCOPE,
      callback:response=>{
        if(response?.access_token){
          sheetsAccessToken=response.access_token;
          sheetsTokenResolve?.(response.access_token);
        }else{
        sheetsTokenReject?.(new Error(response?.error_description||response?.error||'Google authorization was not completed.'));
        }
        sheetsTokenResolve=null;
        sheetsTokenReject=null;
      },
      error_callback:error=>{
        sheetsTokenReject?.(new Error(error?.message||error?.type||'The Google sign-in window was closed.'));
        sheetsTokenResolve=null;
        sheetsTokenReject=null;
      }
    });
    return sheetsTokenClient;
  }

  function requestSheetsAccessToken(config){
    if(sheetsAccessToken) return Promise.resolve(sheetsAccessToken);
    return new Promise((resolve,reject)=>{
      sheetsTokenResolve=resolve;
      sheetsTokenReject=reject;
      initialiseSheetsTokenClient(config).requestAccessToken();
    });
  }

  async function fetchSheetAddresses(config,accessToken){
    const url='https://sheets.googleapis.com/v4/spreadsheets/'+
      `${encodeURIComponent(config.spreadsheetId)}/values/${encodeURIComponent(config.range)}?`+
      new URLSearchParams({majorDimension:'ROWS',valueRenderOption:'FORMATTED_VALUE'});
    const response=await fetch(url,{headers:{Authorization:`Bearer ${accessToken}`}});
    let payload={};
    try{
      payload=await response.json();
    }catch(_error){
      // The status below still produces a useful message for a non-JSON response.
    }
    if(!response.ok){
      if(response.status===401) sheetsAccessToken='';
      const detail=payload?.error?.message||`Google Sheets returned HTTP ${response.status}`;
      throw new Error(detail);
    }
    return (payload.values||[])
      .map(row=>String(row?.[0]??'').trim())
      .filter(Boolean);
  }

  function setSheetImportBusy(busy){
    if(!sheetImportButton||!sheetImportLabel) return;
    sheetImportButton.disabled=busy;
    sheetImportLabel.textContent=busy?'Connecting to Google Sheets...':'Import from Google Sheets';
  }

  async function importAddressesFromGoogleSheets(){
    const config=sheetImportConfig();
    const missing=missingSheetImportConfig(config);
    if(missing.length){
      setSearchResult(
        `<b>Google Sheets import is not configured.</b><br>Still required: ${escapeHtml(missing.join(', '))}.`,
        [],
        true
      );
      return;
    }
    if(searchInput.value.trim()&&!window.confirm('Importing will replace the current address list. Continue?')) return;

    setSheetImportBusy(true);
    setSearchResult('Requesting read-only access and reading the Google Sheet...');
    try{
      await waitForGoogleIdentityServices();
      const accessToken=await requestSheetsAccessToken(config);
      const addresses=await fetchSheetAddresses(config,accessToken);
      if(!addresses.length) throw new Error(`No importable addresses were found in ${config.range}.`);
      searchInput.value=addresses.join('\n');
      searchInput.dispatchEvent(new Event('input',{bubbles:true}));
      sheetImportButton?.classList.add('connected');
      setSearchResult(
        `<b>Imported ${addresses.length} addresses from Google Sheets.</b><br>`+
        `Source: ${escapeHtml(config.range)}. Review the addresses, then click Find and Display.`
      );
      searchInput.focus();
    }catch(error){
      console.error(error);
      setSearchResult(`Google Sheets import failed: ${escapeHtml(error.message||'Unknown error')}`,[],true);
    }finally{
      setSheetImportBusy(false);
    }
  }

  function normaliseText(value){
    return String(value||'')
      .toUpperCase()
      .replace(/[’‘]/g,"'")
      .replace(/[–—]/g,'-')
      .replace(/[.,;，；、:：()[\]]+/g,' ')
      .replace(/\s+/g,' ')
      .trim();
  }

  function normaliseSuburbInput(value){
    return normaliseText(value)
      .replace(/\b(?:AUSTRALIA|VICTORIA|VIC)\b/g,' ')
      .replace(/\b\d{4}\b/g,' ')
      .replace(/\s+/g,' ')
      .trim();
  }

  function escapeHtml(value){
    return String(value)
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'",'&#039;');
  }

  function roadIconStyles(){
    if(roadIconMode==='major'){
      return [
        {featureType:'road.arterial',elementType:'labels.icon',stylers:[{visibility:'off'}]},
        {featureType:'road.local',elementType:'labels.icon',stylers:[{visibility:'off'}]}
      ];
    }
    if(roadIconMode==='custom'){
      return [{featureType:'road',elementType:'labels.icon',stylers:[{visibility:'off'}]}];
    }
    return [];
  }

  function googleMapOptions(){
    const options={
      center:{lat:-37.8136,lng:144.9631},
      zoom:10,
      mapTypeControl:false,
      streetViewControl:false,
      fullscreenControl:true,
      scaleControl:false,
      gestureHandling:'greedy'
    };

    if(roadIconMode==='major'){
      // Retain the old comparison mode. Embedded JSON styles are raster-only.
      options.renderingType=google.maps.RenderingType.RASTER;
      options.isFractionalZoomEnabled=false;
      options.styles=roadIconStyles();
      return options;
    }

    // The default map and option 2 both stay vector-based. This restores the
    // normal fractional mouse-wheel zoom and keeps labels/roads crisp.
    options.renderingType=google.maps.RenderingType.VECTOR;
    options.isFractionalZoomEnabled=true;

    if(roadIconMode==='custom'&&cloudMapId){
      // Road shields and POI icons are controlled by the cloud style attached
      // to this Map ID. Do not also pass the raster-only `styles` option.
      options.mapId=cloudMapId;
    }

    return options;
  }

  function updatePreciseScaleControl(){
    if(!map||!preciseScaleControl) return;
    const center=map.getCenter();
    const zoom=Number(map.getZoom());
    if(!center||!Number.isFinite(zoom)) return;
    const latitudeRadians=center.lat()*Math.PI/180;
    const metresPerPixel=156543.03392804097*Math.cos(latitudeRadians)/Math.pow(2,zoom);
    const metres=metresPerPixel*100;
    const label=metres>=1000
      ?`${(metres/1000).toFixed(1)} km`
      :`${metres.toFixed(1)} m`;
    preciseScaleControl.label.textContent=label;
    preciseScaleControl.element.setAttribute('aria-label',`Map scale: ${label} per 100 pixels`);
  }

  function installPreciseScaleControl(){
    const control=document.createElement('div');
    control.className='map-legend-scale-control';
    const element=document.createElement('div');
    element.className='precise-scale-control';
    element.setAttribute('role','img');
    const label=document.createElement('div');
    label.className='precise-scale-label';
    const bar=document.createElement('div');
    bar.className='precise-scale-bar';
    element.append(label,bar);
    control.append(legendElement,element);
    preciseScaleControl={element,label};
    map.getDiv().appendChild(control);
    if(layoutEditMode) enableLayoutPositionEditor(control);
    updatePreciseScaleControl();
  }

  function enableLayoutPositionEditor(control){
    const storageKey='melbourne-map-legend-scale-position';
    control.classList.add('is-layout-editing');
    const readout=document.createElement('div');
    readout.className='layout-position-readout';
    control.appendChild(readout);

    try{
      const saved=JSON.parse(localStorage.getItem(storageKey)||'null');
      if(Number.isFinite(saved?.right)&&Number.isFinite(saved?.bottom)){
        control.style.right=`${saved.right}px`;
        control.style.bottom=`${saved.bottom}px`;
      }
    }catch(_error){
      localStorage.removeItem(storageKey);
    }

    const currentPosition=()=>({
      right:Math.round(map.getDiv().clientWidth-control.offsetLeft-control.offsetWidth),
      bottom:Math.round(map.getDiv().clientHeight-control.offsetTop-control.offsetHeight)
    });
    const showPosition=()=>{
      const position=currentPosition();
      readout.textContent=`right: ${position.right}px · bottom: ${position.bottom}px`;
      return position;
    };

    control.addEventListener('pointerdown',event=>{
      if(event.button!==0) return;
      event.preventDefault();
      event.stopPropagation();
      const mapDiv=map.getDiv();
      const mapRect=mapDiv.getBoundingClientRect();
      const controlRect=control.getBoundingClientRect();
      const startPointer={x:event.clientX,y:event.clientY};
      const startPosition={left:controlRect.left-mapRect.left,top:controlRect.top-mapRect.top};
      control.style.left=`${startPosition.left}px`;
      control.style.top=`${startPosition.top}px`;
      control.style.right='auto';
      control.style.bottom='auto';
      control.setPointerCapture(event.pointerId);

      const move=moveEvent=>{
        const maxLeft=Math.max(8,mapDiv.clientWidth-control.offsetWidth-8);
        const maxTop=Math.max(8,mapDiv.clientHeight-control.offsetHeight-20);
        const left=Math.min(maxLeft,Math.max(8,startPosition.left+moveEvent.clientX-startPointer.x));
        const top=Math.min(maxTop,Math.max(8,startPosition.top+moveEvent.clientY-startPointer.y));
        control.style.left=`${Math.round(left)}px`;
        control.style.top=`${Math.round(top)}px`;
        showPosition();
      };
      const finish=()=>{
        control.removeEventListener('pointermove',move);
        control.removeEventListener('pointerup',finish);
        control.removeEventListener('pointercancel',finish);
        localStorage.setItem(storageKey,JSON.stringify(showPosition()));
      };
      control.addEventListener('pointermove',move);
      control.addEventListener('pointerup',finish);
      control.addEventListener('pointercancel',finish);
    });

    requestAnimationFrame(showPosition);
  }

  async function loadLocalGeoJson(url,label){
    const response=await fetch(url,{cache:'default'});
    if(!response.ok){
      throw new Error(`${label} file does not exist (${response.status}). Run build-local-boundaries.cmd first.`);
    }
    const data=await response.json();
    if(data?.type!=='FeatureCollection'||!Array.isArray(data.features)){
      throw new Error(`${label} file has an invalid format. Rebuild the local boundary data.`);
    }
    return data;
  }

  function loadAreas(){
    if(!areaLoadPromise){
    areaLoadPromise=loadLocalGeoJson(LOCAL_AREA_URL,'Delivery boundary').catch(error=>{
        areaLoadPromise=null;
        throw error;
      });
    }
    return areaLoadPromise;
  }

  function loadSuburbBoundaries(){
    if(!suburbLoadPromise){
      suburbLoadPromise=loadAreas()
        .then(data=>{
          const suburbs={
            type:'FeatureCollection',
            features:data.features.filter(feature=>feature.properties?.boundary_type==='suburb')
          };
          registerSuburbGeoJson(suburbs);
          return suburbs;
        })
        .catch(error=>{
          suburbLoadPromise=null;
          throw error;
        });
    }
    return suburbLoadPromise;
  }

  function boundaryWeight(){
    const zoom=map?.getZoom()||10;
    if(zoom>=16) return 2.2;
    if(zoom>=14) return 1.8;
    if(zoom>=12) return 1.45;
    return 1.15;
  }

  function suburbBoundaryWeight(){
    const zoom=map?.getZoom()||10;
    if(zoom>=16) return 2;
    if(zoom>=14) return 1.6;
    if(zoom>=12) return 1.3;
    return 1;
  }

  function defaultFeatureStyle(feature){
    const postcode=String(feature.getProperty('postcode')||'');
    const postcodeSelected=searchActive&&selectedPostcodes.has(postcode);
    const color=postcodeSelected?'#A66B00':postcodeGroupColors[Number(feature.getProperty('group'))];
    const visible=postcodeSelected||(boundariesVisible&&Boolean(color));
    return {
      clickable:visible,
      visible,
      strokeColor:color||'#475467',
      strokeOpacity:.9,
      strokeWeight:boundaryWeight(),
      fillColor:postcodeSelected?'#F2B134':color||'#FFFFFF',
      fillOpacity:postcodeSelected?.32:.3
    };
  }

  function suburbFeatureStyle(feature){
    const name=normaliseText(feature.getProperty('locality_name'));
    const storedSelection=selectedSuburbs.get(name);
    const selection=storedSelection?.postcodeOnly?null:storedSelection;
    const marked=suburbHasMarkedResult(name);
    const showAll=!searchActive;
    return {
      clickable:showAll||Boolean(selection),
      visible:showAll||Boolean(selection),
      strokeColor:selection?(marked?'#175CD3':'#A66B00'):'#475467',
      strokeOpacity:showAll||selection ? .9 : 0,
      strokeWeight:suburbBoundaryWeight(),
      fillColor:selection?(marked?'#38BDF8':'#F2B134'):'#FFFFFF',
      fillOpacity:selection ? .32 : .04
    };
  }

  function closeInfo(){
    infoWindow?.close();
    infoOpen=false;
  }

  function openInfo(position,html,headerContent=null){
    if(infoOpen){
      closeInfo();
      return;
    }
    const hasHeader=headerContent!==null&&String(headerContent).trim()!=='';
    infoWindow.setHeaderDisabled(!hasHeader);
    infoWindow.setHeaderContent(hasHeader?headerContent:null);
    infoWindow.setContent(html);
    infoWindow.setPosition(position);
    infoWindow.open({map});
    infoOpen=true;
  }

  function geometryBounds(geometry,bounds=new google.maps.LatLngBounds()){
    geometry?.forEachLatLng(latLng=>bounds.extend(latLng));
    return bounds;
  }

  function collectionValues(collection){
    if(!collection) return [];
    if(typeof collection.getArray==='function') return collection.getArray();
    return Array.from(collection);
  }

  function geometryPolygons(geometry){
    if(!geometry||typeof geometry.getType!=='function') return [];
    const type=geometry.getType();
    if(type==='Polygon'){
      const rings=collectionValues(geometry.getArray()).map(ring=>
        collectionValues(ring.getArray()).map(latLng=>({lat:latLng.lat(),lng:latLng.lng()}))
      );
      return rings.length?[rings]:[];
    }
    if(type==='MultiPolygon'||type==='GeometryCollection'){
      return collectionValues(geometry.getArray()).flatMap(geometryPolygons);
    }
    return [];
  }

  function ringAreaAndCentroid(ring){
    let twiceArea=0;
    let centroidLng=0;
    let centroidLat=0;
    for(let index=0,previous=ring.length-1;index<ring.length;previous=index++){
      const first=ring[previous];
      const second=ring[index];
      const cross=first.lng*second.lat-second.lng*first.lat;
      twiceArea+=cross;
      centroidLng+=(first.lng+second.lng)*cross;
      centroidLat+=(first.lat+second.lat)*cross;
    }
    if(Math.abs(twiceArea)<1e-12){
      const fallback=ring[0]||null;
      return {area:0,point:fallback};
    }
    return {
      area:Math.abs(twiceArea)/2,
      point:{lng:centroidLng/(3*twiceArea),lat:centroidLat/(3*twiceArea)}
    };
  }

  function pointInRing(point,ring){
    let inside=false;
    for(let index=0,previous=ring.length-1;index<ring.length;previous=index++){
      const first=ring[index];
      const second=ring[previous];
      const crosses=(first.lat>point.lat)!==(second.lat>point.lat);
      if(crosses&&point.lng<(second.lng-first.lng)*(point.lat-first.lat)/(second.lat-first.lat)+first.lng){
        inside=!inside;
      }
    }
    return inside;
  }

  function pointInPolygon(point,rings){
    return Boolean(rings[0]&&pointInRing(point,rings[0])&&
      !rings.slice(1).some(ring=>pointInRing(point,ring)));
  }

  function squaredDistanceToSegment(point,first,second,longitudeScale){
    const px=point.lng*longitudeScale;
    const py=point.lat;
    const ax=first.lng*longitudeScale;
    const ay=first.lat;
    const bx=second.lng*longitudeScale;
    const by=second.lat;
    const dx=bx-ax;
    const dy=by-ay;
    const lengthSquared=dx*dx+dy*dy;
    const ratio=lengthSquared?Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/lengthSquared)):0;
    const offsetX=px-(ax+ratio*dx);
    const offsetY=py-(ay+ratio*dy);
    return offsetX*offsetX+offsetY*offsetY;
  }

  function interiorSamplePoint(rings){
    const outer=rings[0]||[];
    if(!outer.length) return null;
    const latitudes=outer.map(point=>point.lat);
    const longitudes=outer.map(point=>point.lng);
    const minLat=Math.min(...latitudes);
    const maxLat=Math.max(...latitudes);
    const minLng=Math.min(...longitudes);
    const maxLng=Math.max(...longitudes);
    const longitudeScale=Math.cos(((minLat+maxLat)/2)*Math.PI/180);
    let bestPoint=null;
    let bestClearance=-1;
    const steps=32;
    for(let row=0;row<steps;row++){
      for(let column=0;column<steps;column++){
        const point={
          lat:minLat+(row+.5)/steps*(maxLat-minLat),
          lng:minLng+(column+.5)/steps*(maxLng-minLng)
        };
        if(!pointInPolygon(point,rings)) continue;
        let clearance=Infinity;
        rings.forEach(ring=>{
          for(let index=0,previous=ring.length-1;index<ring.length;previous=index++){
            clearance=Math.min(clearance,
              squaredDistanceToSegment(point,ring[previous],ring[index],longitudeScale));
          }
        });
        if(clearance>bestClearance){
          bestClearance=clearance;
          bestPoint=point;
        }
      }
    }
    return bestPoint||outer[0];
  }

  function suburbCenter(name){
    const suburbKey=normaliseText(name);
    const override=directSuburbMarkerOverrides[suburbKey];
    if(override) return new google.maps.LatLng(override.lat,override.lng);
    const polygons=(suburbFeatures.get(suburbKey)||[])
      .flatMap(feature=>geometryPolygons(feature.getGeometry()));
    if(!polygons.length) return null;
    const largest=polygons
      .map(rings=>({rings,centroid:ringAreaAndCentroid(rings[0])}))
      .sort((first,second)=>second.centroid.area-first.centroid.area)[0];
    const point=largest.centroid.point&&pointInPolygon(largest.centroid.point,largest.rings)
      ?largest.centroid.point
      :interiorSamplePoint(largest.rings);
    return point?new google.maps.LatLng(point.lat,point.lng):null;
  }

  function setupDefaultLayer(areas){
    defaultData=new google.maps.Data();
    const features=defaultData.addGeoJson(areas);
    defaultData.setStyle(defaultFeatureStyle);
    defaultData.addListener('click',event=>{
      const postcode=String(event.feature.getProperty('postcode')||'');
      const suburbs=event.feature.getProperty('suburbs')||[];
      const group=event.feature.getProperty('group');
      openInfo(
        event.latLng,
        `${searchActive?'':`V${escapeHtml(group)} · `}${escapeHtml(suburbs.join(', '))}`,
        `Postcode ${escapeHtml(postcode)}`
      );
    });
    defaultData.addListener('mouseover',event=>{
      defaultData.overrideStyle(event.feature,{fillOpacity:.55,strokeWeight:boundaryWeight()+1});
    });
    defaultData.addListener('mouseout',event=>defaultData.revertStyle(event.feature));

    defaultBounds=new google.maps.LatLngBounds();
    features.forEach(feature=>{
      const postcode=String(feature.getProperty('postcode')||'');
      geometryBounds(feature.getGeometry(),defaultBounds);
      const bounds=geometryBounds(feature.getGeometry());
      if(bounds.isEmpty()||postcodeLabels.has(postcode)) return;
      postcodeLabels.set(postcode,new google.maps.Marker({
        position:bounds.getCenter(),
        map:null,
        clickable:false,
        optimized:false,
        zIndex:4,
        icon:{path:google.maps.SymbolPath.CIRCLE,scale:0},
        label:{text:postcode,color:'#ffffff',fontSize:'10px',fontWeight:'700',className:'postcode-label'}
      }));
    });
  }

  function updatePostcodeLabels(){
    const zoomReady=staticMode||(map?.getZoom()||0)>=12;
    postcodeLabels.forEach(marker=>{
      const show=zoomReady&&boundariesVisible;
      marker.setMap(show?map:null);
    });
  }

  function ensureSuburbLayer(){
    if(suburbData) return;
    suburbData=new google.maps.Data();
    suburbData.setStyle(suburbFeatureStyle);
    suburbData.addListener('click',event=>{
      event.stop?.();
      const name=normaliseText(event.feature.getProperty('locality_name'));
      if(searchActive&&directSuburbNames.has(name)){
        openInfo(event.latLng,'',name);
        return;
      }
      const modifierPressed=Boolean(event.domEvent?.ctrlKey||event.domEvent?.metaKey);
      if(searchActive&&modifierPressed){
        const matchingAddresses=addressRecordsForSuburb(name);
        if(matchingAddresses.length===1){
          closeInfo();
          toggleAddressRecordSelection(matchingAddresses[0]);
          return;
        }
      }
      openInfo(event.latLng,suburbInfoHtml(name),name);
    });
    suburbData.addListener('mouseover',event=>{
      const name=normaliseText(event.feature.getProperty('locality_name'));
      if(!searchActive||selectedSuburbs.has(name)){
        const marked=suburbHasMarkedResult(name);
        suburbData.overrideStyle(event.feature,{
          fillOpacity:searchActive ? .45 : .12,
          strokeColor:searchActive?(marked?'#0C4A6E':'#7A4E00'):'#344054'
        });
      }
    });
    suburbData.addListener('mouseout',event=>suburbData.revertStyle(event.feature));
  }

  function registerSuburbGeoJson(data){
    ensureSuburbLayer();
    const added=suburbData.addGeoJson(data);
    if(!defaultBounds) defaultBounds=new google.maps.LatLngBounds();
    added.forEach(feature=>{
      const name=normaliseText(feature.getProperty('locality_name'));
      if(!suburbFeatures.has(name)) suburbFeatures.set(name,[]);
      suburbFeatures.get(name).push(feature);
      const zone=feature.getProperty('zone');
      if(zone) suburbZoneByName.set(name,zone);
      const postcodes=feature.getProperty('delivery_postcodes');
      (Array.isArray(postcodes)?postcodes:[postcodes]).filter(Boolean).forEach(postcode=>{
        const key=String(postcode).trim();
        if(!postcodeSuburbs.has(key)) postcodeSuburbs.set(key,new Set());
        postcodeSuburbs.get(key).add(name);
      });
      if(!defaultData) geometryBounds(feature.getGeometry(),defaultBounds);
    });
    return added;
  }

  async function ensureSuburbBoundaries(rawNames=[]){
    await loadSuburbBoundaries();
  }

  async function ensureSpecificSuburb(rawName){
    const requested=normaliseSuburbInput(rawName);
    if(suburbFeatures.has(requested)) return requested;
    const partial=[...suburbFeatures.keys()].filter(name=>name.includes(requested)||requested.includes(name));
    if(partial.length===1) return partial[0];
    return null;
  }

  async function getSuburbZone(name){
    if(localityZones[name]) return localityZones[name];
    return suburbZoneByName.get(name)||'Outside delivery area';
  }

  function cleanAddress(value){
    let address=String(value||'')
      .replace(/[，；]/g,',')
      .replace(/[–—]/g,'-')
      .replace(/\bIA\s+TROBE\b/ig,'La Trobe')
      .trim();
    address=address
      .replace(/^(?:(?:UNIT|APT|APARTMENT|SHOP|SUITE|FLAT|LEVEL|LOT)\s+|U\s*)?[A-Z]*\d+[A-Z-]*\s*\/\s*(?=\d)/i,'')
      .replace(/^(?:UNIT|APT|APARTMENT|SHOP|SUITE|FLAT)\s+[A-Z0-9-]+(?:\s*\([^)]*\))?\s*,?\s*/i,'')
      .replace(/^U\s*[A-Z0-9-]+\s*,?\s*/i,'')
      .replace(/^LEVEL\s+[A-Z0-9-]+\s*,?\s*/i,'')
      .replace(/^(?:LOT\s+[A-Z0-9-]+\s*,?\s*)+/i,'')
      .replace(/\s+/g,' ')
      .trim();
    return address;
  }
  console.assert(cleanAddress('U1/163 La Trobe St, Melbourne VIC 3000')==='163 La Trobe St, Melbourne VIC 3000','cleanAddress slash-unit regression');
  console.assert(cleanAddress('U1/163 Ia Trobe St, Melbourne VIC 3000')==='163 La Trobe St, Melbourne VIC 3000','cleanAddress La Trobe spelling regression');

  function matchesRequestedPostcode(input,resultPostcode){
    const requested=String(input||'').match(/\b3\d{3}\b/)?.[0];
    return !requested||String(resultPostcode||'')===requested;
  }
  console.assert(!matchesRequestedPostcode('163 La Trobe St, Melbourne VIC 3000','3205'),'geocode postcode regression');

  const addressOverrides=new Map([
    ['163 LA TROBE ST MELBOURNE VIC 3000',{address:'163 La Trobe Street, Melbourne VIC 3000',locality:'MELBOURNE',postcode:'3000',coordinates:[144.9670359,-37.8088827]}]
  ]);

  function addressOverride(value){
    const key=normaliseText(cleanAddress(value)).replace(/\bSTREET\b/g,'ST').replace(/\s+AUSTRALIA$/,'');
    const override=addressOverrides.get(key);
    if(!override) return null;
    return {feature:{type:'Feature',properties:{ezi_address:override.address,locality_name:override.locality,postcode:override.postcode},geometry:{type:'Point',coordinates:[...override.coordinates]}},ambiguous:false};
  }
  console.assert(addressOverride('U1/163 La Trobe St, Melbourne VIC 3000')?.feature.geometry.coordinates[0]===144.9670359,'address override regression');

  function isAddressInput(value){
    const query=normaliseText(value);
    return /^(?:(?:UNIT|SHOP|APT|APARTMENT|SUITE|FLAT|LEVEL)\b|U\s*\d|[A-Z]*\d)/.test(query);
  }

  function isPostcodeInput(value){
    return /^3\d{3}$/.test(String(value||'').trim());
  }

  function addressComponent(result,type){
    return result.address_components?.find(component=>component.types.includes(type))?.long_name||'';
  }

  function fallbackSuburb(input){
    const withoutState=cleanAddress(input)
      .replace(/\b(?:AUSTRALIA|VICTORIA|VIC)\b/ig,' ')
      .replace(/\b3\d{3}\b/g,' ')
      .replace(/\s+/g,' ')
      .trim();
    const commaParts=withoutState.split(',').map(part=>part.trim()).filter(Boolean);
    return commaParts.length>1?commaParts.at(-1):'';
  }

  async function geocodeAddress(input){
    const cleaned=cleanAddress(input);
    const key=normaliseText(cleaned);
    const requestedPostcode=cleaned.match(/\b3\d{3}\b/)?.[0]||'';
    if(sessionGeocodeCache.has(key)) return sessionGeocodeCache.get(key);
    const override=addressOverride(cleaned);
    if(override){
      sessionGeocodeCache.set(key,override);
      return override;
    }
    const requestAddress=/\b(?:VIC|VICTORIA|AUSTRALIA)\b/i.test(cleaned)
      ?cleaned
      :`${cleaned}, Victoria, Australia`;
    const response=await geocoder.geocode({
      address:requestAddress,
      componentRestrictions:{country:'AU',...(requestedPostcode?{postalCode:requestedPostcode}:{})},
      region:'au'
    });
    const candidates=(response.results||[]).filter(result=>{
      const postcode=addressComponent(result,'postal_code');
      const state=addressComponent(result,'administrative_area_level_1');
      return (!postcode||/^3\d{3}$/.test(postcode))&&matchesRequestedPostcode(cleaned,postcode)&&(!state||/Victoria|VIC/i.test(state));
    });
    const result=candidates[0]||(!requestedPostcode?response.results?.[0]:null);
    if(!result) return null;
    const postcode=addressComponent(result,'postal_code');
    const locality=addressComponent(result,'locality')||
      addressComponent(result,'postal_town')||
      addressComponent(result,'sublocality_level_1')||
      fallbackSuburb(input);
    const match={
      feature:{
        type:'Feature',
        properties:{
          ezi_address:result.formatted_address,
          locality_name:normaliseText(locality),
          postcode:String(postcode||'')
        },
        geometry:{
          type:'Point',
          coordinates:[result.geometry.location.lng(),result.geometry.location.lat()]
        }
      },
      ambiguous:false
    };
    sessionGeocodeCache.set(key,match);
    return match;
  }

  async function mapWithConcurrency(items,limit,worker,onProgress){
    const results=new Array(items.length);
    let nextIndex=0;
    let completed=0;
    async function run(){
      while(nextIndex<items.length){
        const index=nextIndex++;
        try{
          results[index]=await worker(items[index],index);
        }catch(error){
          results[index]={ok:false,input:items[index],reason:error.message||'Search failed'};
        }
        completed++;
        onProgress?.(completed,items.length);
      }
    }
    await Promise.all(Array.from({length:Math.min(limit,items.length)},run));
    return results;
  }

  async function geocodeAddressesBatch(items){
    const matches=new Map();
    await mapWithConcurrency(items,5,async item=>{
      try{
        matches.set(item.index,{match:await geocodeAddress(item.input)});
      }catch(error){
        matches.set(item.index,{error});
      }
    });
    return matches;
  }

  function usesPostcodeBoundary(deliveryPostcodes,postcode){
    const postcodes=new Set(deliveryPostcodes.map(String).filter(Boolean));
    return Boolean(postcode&&postcodes.size>1&&postcodes.has(String(postcode)));
  }
  console.assert(usesPostcodeBoundary(['3000','3004'],'3000'),'multi-postcode boundary regression');

  function mergeSuburbSelection(name,zone,lineNumber,postcode=''){
    const deliveryPostcodes=(suburbFeatures.get(name)||[]).flatMap(feature=>{
      const values=feature.getProperty('delivery_postcodes');
      return Array.isArray(values)?values:[values];
    });
    const postcodeOnly=usesPostcodeBoundary(deliveryPostcodes,postcode);
    const existing=selectedSuburbs.get(name);
    if(!existing){
      selectedSuburbs.set(name,{zone,lineNumbers:[lineNumber],postcodeOnly,postcodes:new Set(postcodeOnly?[String(postcode)]:[])});
      return;
    }
    existing.lineNumbers.push(lineNumber);
    existing.postcodeOnly=existing.postcodeOnly&&postcodeOnly;
    if(postcodeOnly) existing.postcodes.add(String(postcode));
    if(existing.zone!==zone&&zone!=='Outside delivery area'&&existing.zone!=='Outside delivery area'){
      existing.zone='Mixed';
    }else if(existing.zone==='Outside delivery area'&&zone!=='Outside delivery area'){
      existing.zone=zone;
    }
  }

  function syncSelectedPostcodes(){
    selectedPostcodes.clear();
    selectedSuburbs.forEach(selection=>{
      if(selection.postcodeOnly) selection.postcodes.forEach(postcode=>selectedPostcodes.add(postcode));
    });
  }

  function markerIcon(){
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40"><path d="M14 1C6.82 1 1 6.82 1 14c0 10.18 13 25 13 25s13-14.82 13-25C27 6.82 21.18 1 14 1Z" fill="#EA4335" stroke="#FFFFFF" stroke-width="3.2"/><path d="M14 1C6.82 1 1 6.82 1 14c0 10.18 13 25 13 25s13-14.82 13-25C27 6.82 21.18 1 14 1Z" fill="#EA4335" stroke="#B3261E" stroke-width="1.2"/><circle cx="14" cy="14" r="5.5" fill="#B3261E"/></svg>`;
    return {
      url:`data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
      scaledSize:new google.maps.Size(21,30),
      anchor:new google.maps.Point(10.5,30)
    };
  }

  function addressMarkerHtml(){
    const element=document.createElement('div');
    element.className='delivery-address-pin';
    element.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40" aria-hidden="true"><path d="M14 1C6.82 1 1 6.82 1 14c0 10.18 13 25 13 25s13-14.82 13-25C27 6.82 21.18 1 14 1Z" fill="#EA4335" stroke="#FFFFFF" stroke-width="3.2"/><path d="M14 1C6.82 1 1 6.82 1 14c0 10.18 13 25 13 25s13-14.82 13-25C27 6.82 21.18 1 14 1Z" fill="#EA4335" stroke="#B3261E" stroke-width="1.2"/><circle cx="14" cy="14" r="5.5" fill="#B3261E"/></svg>';
    return element;
  }

  function suburbLabelHtml(name){
    const element=document.createElement('div');
    element.className='delivery-suburb-label';
    element.textContent=name;
    return element;
  }

  const labelAnchors={
    right:{left:'14px',top:'-28px'},
    top:{left:'-50%',top:'calc(-100% - 36px)'},
    left:{left:'calc(-100% - 14px)',top:'-28px'},
    bottom:{left:'-50%',top:'8px'}
  };

  function setAddressLabelPlacement(record,placement){
    const anchor=labelAnchors[placement]||labelAnchors.right;
    record.placement=placement;
    record.label.anchorLeft=anchor.left;
    record.label.anchorTop=anchor.top;
  }

  function labelCandidateBox(point,width,height,placement){
    if(placement==='top') return {left:point.x-width/2,top:point.y-height-36,right:point.x+width/2,bottom:point.y-36};
    if(placement==='left') return {left:point.x-width-14,top:point.y-28,right:point.x-14,bottom:point.y-28+height};
    if(placement==='bottom') return {left:point.x-width/2,top:point.y+8,right:point.x+width/2,bottom:point.y+8+height};
    return {left:point.x+14,top:point.y-28,right:point.x+14+width,bottom:point.y-28+height};
  }

  function boxesOverlap(a,b,padding=5){
    return !(a.right+padding<=b.left||a.left>=b.right+padding||a.bottom+padding<=b.top||a.top>=b.bottom+padding);
  }

  function layoutAddressLabels(){
    if(!map||!markerProjection) return;
    const projection=markerProjection.getProjection();
    if(!projection) return;
    const zoom=map.getZoom()||0;
    const records=[
      ...addressMarkers.filter(record=>record.kind==='advanced'),
      ...[...suburbSearchMarkers.values()].filter(record=>record.kind==='suburb-advanced')
    ];
    if(!suburbTagsVisible){
      records.forEach(record=>{record.label.map=null});
      return;
    }
    const showLabels=zoom>=9;
    const mapDiv=map.getDiv();
    const mapWidth=mapDiv.clientWidth;
    const mapHeight=mapDiv.clientHeight;
    const points=new Map();
    records.forEach(record=>points.set(record,projection.fromLatLngToContainerPixel(new google.maps.LatLng(record.position))));
    const pinBoxes=records.map(record=>{
      const point=points.get(record);
      return {record,left:point.x-13,top:point.y-34,right:point.x+13,bottom:point.y+4};
    });
    const occupied=[];

    records.forEach((record,index)=>{
      record.labelElement.classList.toggle('is-detailed',zoom>=14);
      if(!showLabels&&!record.hovering){
        record.label.map=null;
        return;
      }
      const point=points.get(record);
      const width=Math.min(190,Math.max(74,24+String(record.suburb).length*(zoom>=14?7.4:6.9)));
      const height=zoom>=14?28:26;
      let directions=['right','top','left','bottom'];
      if(point.x>mapWidth*.72) directions=['left','top','bottom','right'];
      else if(point.x<mapWidth*.28) directions=['right','top','bottom','left'];
      else if(index%2) directions=['top','right','left','bottom'];
      let chosen=null;
      for(const direction of directions){
        const box=labelCandidateBox(point,width,height,direction);
        const within=box.left>=8&&box.top>=8&&box.right<=mapWidth-8&&box.bottom<=mapHeight-8;
        const hitsLabel=occupied.some(other=>boxesOverlap(box,other));
        const hitsPin=pinBoxes.some(other=>other.record!==record&&boxesOverlap(box,other,2));
        if(within&&!hitsLabel&&!hitsPin){
          chosen={direction,box};
          break;
        }
      }
      if(!chosen&&!record.hovering){
        record.label.map=null;
        return;
      }
      setAddressLabelPlacement(record,chosen?.direction||record.placement||'right');
      record.label.map=map;
      if(chosen) occupied.push(chosen.box);
    });
  }

  function updateSuburbTagToggle(){
    if(!suburbTagToggleButton||!suburbTagToggleLabel) return;
    const available=addressMarkers.length>0||suburbSearchMarkers.size>0;
    const active=available&&suburbTagsVisible;
    suburbTagToggleButton.disabled=!available;
    suburbTagToggleButton.classList.toggle('active',active);
    suburbTagToggleButton.setAttribute('aria-pressed',String(active));
    suburbTagToggleLabel.textContent=active?'Hide Suburb Names':'Show Suburb Names';
  }

  function setSuburbTagsVisible(visible){
    suburbTagsVisible=Boolean(visible);
    addressMarkers.forEach(item=>{
      if(item.kind==='advanced'){
        item.marker.map=suburbTagsVisible?map:null;
        if(!suburbTagsVisible) item.label.map=null;
      }else item.setMap(suburbTagsVisible?map:null);
    });
    suburbSearchMarkers.forEach(item=>{
      if(item.kind==='suburb-advanced'){
        item.marker.map=suburbTagsVisible?map:null;
        if(!suburbTagsVisible) item.label.map=null;
      }else item.marker.setMap(suburbTagsVisible?map:null);
    });
    updateSuburbTagToggle();
    requestAnimationFrame(layoutAddressLabels);
  }

  function suburbHasMarkedResult(name){
    const suburbKey=normaliseText(name);
    return addressMarkers.some(item=>item.kind==='advanced'&&item.marked&&item.suburbKey===suburbKey);
  }

  function addressRecordsForSuburb(name){
    const suburbKey=normaliseText(name);
    return addressMarkers.filter(item=>item.kind==='advanced'&&item.suburbKey===suburbKey);
  }

  function suburbInfoHtml(name){
    const matchingAddresses=addressRecordsForSuburb(name);
    const addressHtml=matchingAddresses.length
      ?matchingAddresses
        .slice()
        .sort((a,b)=>a.lineNumber-b.lineNumber)
        .map(record=>
          `<div style="margin-top:6px;line-height:1.35">`+
            `<span style="color:#667085">${record.lineNumber}.</span> ${escapeHtml(record.address)}`+
          `</div>`
        )
        .join('')
      :'<div style="margin-top:6px;color:#667085">No specific address in this area is included in the current search.</div>';
    return `<div style="min-width:180px;max-width:320px">${addressHtml}</div>`;
  }

  function updateAddressRecordAppearance(record){
    if(record.kind!=='advanced') return;
    record.pinElement.classList.toggle('is-marked',record.marked);
    record.labelElement.classList.toggle('is-marked',record.marked);
    record.pinElement.classList.toggle('is-pending',record.pending);
    record.labelElement.classList.toggle('is-pending',record.pending);
  }

  function pendingAddressRecords(){
    return addressMarkers.filter(item=>item.kind==='advanced'&&item.pending);
  }

  function updateResultMarkButton(){
    if(!resultMarkButton||!resultMarkLabel) return;
    const pending=pendingAddressRecords();
    const hasMarked=pending.some(item=>item.marked);
    const hasUnmarked=pending.some(item=>!item.marked);
    const actionLabel=hasMarked&&hasUnmarked
      ?'Toggle Marked State'
      :hasMarked?'Clear Marks':'Mark Selected Results';
    resultMarkButton.disabled=pending.length===0;
    resultMarkButton.classList.toggle('ready',pending.length>0);
    resultMarkLabel.textContent=pending.length
      ?`${actionLabel} (${pending.length})`
      :'Mark Selected Results';
  }

  function toggleAddressRecordSelection(record){
    record.pending=!record.pending;
    updateAddressRecordAppearance(record);
    updateResultMarkButton();
  }

  function clearPendingAddressSelections(){
    const pending=pendingAddressRecords();
    if(!pending.length) return;
    pending.forEach(record=>{
      record.pending=false;
      updateAddressRecordAppearance(record);
    });
    updateResultMarkButton();
    requestAnimationFrame(layoutAddressLabels);
  }

  function applyPendingAddressMarks(){
    const pending=pendingAddressRecords();
    if(!pending.length) return;
    pending.forEach(record=>{
      record.marked=!record.marked;
      record.pending=false;
      updateAddressRecordAppearance(record);
    });
    updateResultMarkButton();
    suburbData?.setStyle(suburbFeatureStyle);
    updateLegend();
    requestAnimationFrame(layoutAddressLabels);
  }

  function addAddressMarker(result){
    const [longitude,latitude]=result.feature.geometry.coordinates;
    const props=result.feature.properties;
    const position={lat:latitude,lng:longitude};

    if(AdvancedMarkerElement){
      const pinElement=addressMarkerHtml();
      const labelElement=suburbLabelHtml(props.locality_name);
      const marker=new AdvancedMarkerElement({
        position,
        map,
        content:pinElement,
        title:`${result.lineNumber}. ${props.ezi_address}`,
        zIndex:1000-result.lineNumber,
        gmpClickable:true,
        collisionBehavior:google.maps.CollisionBehavior.REQUIRED_AND_HIDES_OPTIONAL
      });
      const label=new AdvancedMarkerElement({
        position,
        map:null,
        content:labelElement,
        title:props.locality_name,
        zIndex:900-result.lineNumber,
        gmpClickable:true,
        collisionBehavior:google.maps.CollisionBehavior.REQUIRED_AND_HIDES_OPTIONAL
      });
      const record={
        kind:'advanced',
        marker,
        label,
        pinElement,
        labelElement,
        position,
        suburb:props.locality_name,
        suburbKey:normaliseText(props.locality_name),
        lineNumber:result.lineNumber,
        address:props.ezi_address,
        placement:'right',
        hovering:false,
        pending:false,
        marked:false
      };
      setAddressLabelPlacement(record,'right');
      const showInfo=()=>openInfo(
        position,
        `<b>${result.lineNumber}. ${escapeHtml(props.ezi_address)}</b><br>`+
        `${props.postcode?`Postcode ${escapeHtml(props.postcode)}`:'No postcode'}`,
        props.locality_name
      );
      const handleResultClick=event=>{
        event.preventDefault();
        event.stopPropagation();
        if(event.ctrlKey||event.metaKey){
          closeInfo();
          toggleAddressRecordSelection(record);
          return;
        }
        showInfo();
      };
      pinElement.addEventListener('click',handleResultClick);
      labelElement.addEventListener('click',handleResultClick);
      const setHovering=value=>{
        record.hovering=value;
        layoutAddressLabels();
      };
      pinElement.addEventListener('mouseenter',()=>setHovering(true));
      pinElement.addEventListener('mouseleave',()=>setHovering(false));
      labelElement.addEventListener('mouseenter',()=>setHovering(true));
      labelElement.addEventListener('mouseleave',()=>setHovering(false));
      updateAddressRecordAppearance(record);
      addressMarkers.push(record);
      updateResultMarkButton();
      requestAnimationFrame(layoutAddressLabels);
      return;
    }

    const marker=new google.maps.Marker({
      position,
      map,
      zIndex:20,
      icon:markerIcon(),
      title:`${result.lineNumber}. ${props.ezi_address}`
    });
    marker.addListener('click',()=>openInfo(
      marker.getPosition(),
      `<b>${result.lineNumber}. ${escapeHtml(props.ezi_address)}</b><br>`+
      `${props.postcode?`Postcode ${escapeHtml(props.postcode)}`:'No postcode'}`,
      props.locality_name
    ));
    addressMarkers.push(marker);
  }

  function addDirectSuburbMarker(result){
    const name=normaliseText(result.suburbName);
    if(!name||suburbSearchMarkers.has(name)) return;
    const center=suburbCenter(name);
    if(!center) return;
    const position={lat:center.lat(),lng:center.lng()};
    const showInfo=()=>openInfo(position,'',name);

    if(AdvancedMarkerElement){
      const pinElement=addressMarkerHtml();
      const labelElement=suburbLabelHtml(name);
      const marker=new AdvancedMarkerElement({
        position,
        map,
        content:pinElement,
        title:name,
        zIndex:850-result.lineNumber,
        gmpClickable:true,
        collisionBehavior:google.maps.CollisionBehavior.REQUIRED_AND_HIDES_OPTIONAL
      });
      const label=new AdvancedMarkerElement({
        position,
        map:null,
        content:labelElement,
        title:name,
        zIndex:800-result.lineNumber,
        gmpClickable:true,
        collisionBehavior:google.maps.CollisionBehavior.REQUIRED_AND_HIDES_OPTIONAL
      });
      const record={
        kind:'suburb-advanced',
        marker,
        label,
        pinElement,
        labelElement,
        position,
        suburb:name,
        suburbKey:name,
        placement:'right',
        hovering:false
      };
      setAddressLabelPlacement(record,'right');
      const handleClick=event=>{
        event.preventDefault();
        event.stopPropagation();
        showInfo();
      };
      pinElement.addEventListener('click',handleClick);
      labelElement.addEventListener('click',handleClick);
      const setHovering=value=>{
        record.hovering=value;
        layoutAddressLabels();
      };
      pinElement.addEventListener('mouseenter',()=>setHovering(true));
      pinElement.addEventListener('mouseleave',()=>setHovering(false));
      labelElement.addEventListener('mouseenter',()=>setHovering(true));
      labelElement.addEventListener('mouseleave',()=>setHovering(false));
      suburbSearchMarkers.set(name,record);
      requestAnimationFrame(layoutAddressLabels);
      return;
    }

    const marker=new google.maps.Marker({
      position,
      map,
      zIndex:18,
      icon:markerIcon(),
      title:name,
      label:{text:name,color:'#202124',fontSize:'12px',fontWeight:'500'}
    });
    marker.addListener('click',showInfo);
    suburbSearchMarkers.set(name,{kind:'suburb-standard',marker,position});
  }

  function clearAddressMarkers(){
    addressMarkers.splice(0).forEach(item=>{
      if(item.kind==='advanced'){
        item.marker.map=null;
        item.label.map=null;
      }else{
        item.setMap(null);
      }
    });
    suburbSearchMarkers.forEach(item=>{
      if(item.kind==='suburb-advanced'){
        item.marker.map=null;
        item.label.map=null;
      }else{
        item.marker.setMap(null);
      }
    });
    suburbSearchMarkers.clear();
    directSuburbNames.clear();
    updateResultMarkButton();
  }

  function updateAddressMarkerSizes(){
    addressMarkers.forEach(item=>{
      if(item.kind!=='advanced') item.setIcon(markerIcon());
    });
    suburbSearchMarkers.forEach(item=>{
      if(item.kind==='suburb-standard') item.marker.setIcon(markerIcon());
    });
    requestAnimationFrame(layoutAddressLabels);
  }

  function updateSearchProgress(completed,total){
    searchProgress.hidden=false;
    searchProgressBar.style.width=`${Math.round(completed/total*100)}%`;
  }

  function setSearchResult(message,errors=[],isError=false){
    searchResults.classList.toggle('error',isError);
    searchResults.classList.add('visible');
    searchResults.innerHTML=message;
    if(errors.length){
      const list=document.createElement('ul');
      list.className='result-errors';
      errors.forEach(error=>{
        const item=document.createElement('li');
        item.textContent=error;
        list.appendChild(item);
      });
      searchResults.appendChild(list);
    }
  }

  function updateLegend(){
    legendElement.hidden=false;
    if(searchActive){
      const hasMarked=addressMarkers.some(item=>item.kind==='advanced'&&item.marked);
      const hasAddresses=addressMarkers.length>0;
      const hasSuburbPoints=suburbSearchMarkers.size>0;
      legendElement.innerHTML=
        (selectedSuburbs.size?'<span class="sw" style="background:#F2B134"></span>Selected suburb&nbsp;&nbsp;':'')+
        (hasAddresses?'<span class="sw" style="background:#EA4335;border-radius:50% 50% 50% 0;transform:rotate(-45deg)"></span>Address':'')+
        (hasSuburbPoints?`${hasAddresses?'&nbsp;&nbsp;':''}<span class="sw" style="background:#EA4335;border-radius:50% 50% 50% 0;transform:rotate(-45deg)"></span>Suburb center`:'')+
        (hasMarked?'&nbsp;&nbsp;<span class="sw" style="background:#38BDF8"></span>Marked suburb&nbsp;&nbsp;<span class="sw" style="background:#2F80ED;border-radius:50% 50% 50% 0;transform:rotate(-45deg)"></span>Marked address':'');
    }else if(boundariesVisible){
      legendElement.innerHTML=
        '<span class="sw" style="background:#2563EB"></span>V1&nbsp;&nbsp;'+
        '<span class="sw" style="background:#16A34A"></span>V2&nbsp;&nbsp;'+
        '<span class="sw" style="background:#F59E0B"></span>V3&nbsp;&nbsp;'+
        '<span class="sw" style="background:#9333EA"></span>V4';
    }else{
      legendElement.innerHTML='';
      legendElement.hidden=true;
    }
  }

  function updateBoundaryToggle(){
    if(!boundaryToggleButton||!boundaryToggleLabel) return;
    boundaryToggleButton.disabled=!defaultData||searchActive;
    boundaryToggleButton.classList.toggle('active',boundariesVisible);
    boundaryToggleButton.setAttribute('aria-pressed',String(boundariesVisible));
    boundaryToggleLabel.textContent=`${boundariesVisible?'Hide':'Show'} V1–V4 Postcode Areas`;
  }

  function setAllBoundariesVisible(visible){
    boundariesVisible=Boolean(visible)&&!searchActive;
    defaultData?.setMap(boundariesVisible?map:null);
    defaultData?.setStyle(defaultFeatureStyle);
    if(!boundariesVisible) closeInfo();
    updatePostcodeLabels();
    updateBoundaryToggle();
    updateLegend();
  }

  function showSearchMode(){
    searchActive=true;
    boundariesVisible=false;
    defaultData?.setMap(selectedPostcodes.size?map:null);
    defaultData?.setStyle(defaultFeatureStyle);
    suburbData?.setMap(map);
    suburbData?.setStyle(suburbFeatureStyle);
    updatePostcodeLabels();
    updateBoundaryToggle();
    updateLegend();
  }

  function fitSearchResults(){
    const bounds=new google.maps.LatLngBounds();
    addressMarkers.forEach(item=>bounds.extend(item.kind==='advanced'?item.position:item.getPosition()));
    selectedSuburbs.forEach((selection,name)=>{
      if(selection.postcodeOnly) return;
      (suburbFeatures.get(name)||[]).forEach(feature=>geometryBounds(feature.getGeometry(),bounds));
    });
    if(bounds.isEmpty()) return;
    map.fitBounds(bounds,48);
    google.maps.event.addListenerOnce(map,'idle',()=>{
      const fittedZoom=Math.min(Number(map.getZoom())||15,15);
      // Keep every result visible, then zoom out one additional level so the
      // user can immediately understand the results' position in Melbourne.
      map.setZoom(Math.max(fittedZoom-1,7));
    });
  }

  function resetSearch(clearInput=true){
    selectedSuburbs.clear();
    selectedPostcodes.clear();
    clearAddressMarkers();
    setSuburbTagsVisible(true);
    searchActive=false;
    boundariesVisible=false;
    defaultData?.setMap(null);
    defaultData?.setStyle(defaultFeatureStyle);
    suburbData?.setMap(null);
    suburbData?.setStyle(suburbFeatureStyle);
    if(clearInput){
      searchInput.value='';
      updateInputCount();
    }
    searchResults.className='search-results';
    searchResults.textContent='';
    searchProgress.hidden=true;
    searchProgressBar.style.width='0';
    closeInfo();
    updatePostcodeLabels();
    updateBoundaryToggle();
    updateLegend();
    if(defaultBounds&&!defaultBounds.isEmpty()) map.fitBounds(defaultBounds,35);
  }

  async function runBatchSearch(){
    const lines=parseSearchItems(searchInput.value);
    if(!lines.length){
      setSearchResult('Enter at least one address, suburb or postcode first.',[],true);
      return;
    }

    if(boundariesVisible) setAllBoundariesVisible(false);
    setSuburbTagsVisible(true);
    if(suburbTagToggleButton) suburbTagToggleButton.disabled=true;

    searchButton.disabled=true;
    clearButton.disabled=true;
    if(boundaryToggleButton) boundaryToggleButton.disabled=true;
    searchProgressBar.style.width='0';
    searchProgress.hidden=false;
    setSearchResult(`Searching ${lines.length} entries...`);

    try{
      selectedSuburbs.clear();
      selectedPostcodes.clear();
      clearAddressMarkers();
      const addressItems=lines.map((input,index)=>({input,index})).filter(item=>isAddressInput(item.input)&&!isPostcodeInput(item.input));
      const requestedDirectSuburbNames=lines.filter(input=>!isAddressInput(input)&&!isPostcodeInput(input)).map(normaliseSuburbInput);
      const directBoundaryRequest=ensureSuburbBoundaries(requestedDirectSuburbNames);
      const addressMatches=await geocodeAddressesBatch(addressItems);
      const addressSuburbNames=[...addressMatches.values()]
        .map(result=>result.match?.feature?.properties?.locality_name)
        .filter(Boolean);
      await directBoundaryRequest;
      await ensureSuburbBoundaries(addressSuburbNames);

      const results=await mapWithConcurrency(lines,5,async(input,index)=>{
        const lineNumber=index+1;
        if(isPostcodeInput(input)){
          const names=[...(postcodeSuburbs.get(input)||[])].sort();
          if(!names.length) return {ok:false,input,reason:'No suburb boundary was found for this postcode'};
          const suburbs=[];
          for(const suburbName of names){
            const zone=await getSuburbZone(suburbName);
            mergeSuburbSelection(suburbName,zone,lineNumber);
            suburbs.push({ok:true,type:'suburb',input,lineNumber,suburbName,zone});
          }
          return {ok:true,type:'postcode',input,lineNumber,suburbs};
        }
        if(isAddressInput(input)){
          const batchResult=addressMatches.get(index);
          if(batchResult?.error) return {ok:false,input,reason:batchResult.error.message||'Google address lookup failed'};
          const match=batchResult?.match||null;
          if(!match) return {ok:false,input,reason:'No matching address found'};
          const props=match.feature.properties;
          const requestedSuburb=props.locality_name||fallbackSuburb(input);
          const suburbName=await ensureSpecificSuburb(requestedSuburb);
          let zone='Outside delivery area';
          if(suburbName){
            zone=props.postcode==='3095'
              ?localityZones[suburbName]||zoneByPostcode[props.postcode]||'Outside delivery area'
              :zoneByPostcode[props.postcode]||'Outside delivery area';
            mergeSuburbSelection(suburbName,zone,lineNumber,props.postcode);
          }
          return {
            ok:true,
            type:'address',
            input,
            lineNumber,
            feature:match.feature,
            suburbName:suburbName||normaliseSuburbInput(requestedSuburb),
            zone,
            ambiguous:false,
            notice:suburbName?'':'Address located, but no local suburb boundary is available'
          };
        }
        const suburbName=await ensureSpecificSuburb(input);
        if(!suburbName) return {ok:false,input,reason:'No matching suburb found'};
        const zone=await getSuburbZone(suburbName);
        mergeSuburbSelection(suburbName,zone,lineNumber);
        return {ok:true,type:'suburb',input,lineNumber,suburbName,zone};
      },updateSearchProgress);

      syncSelectedPostcodes();
      showSearchMode();
      results.filter(result=>result?.ok&&result.type==='address').forEach(addAddressMarker);
      const suburbResults=results.flatMap(result=>{
        if(result?.ok&&result.type==='suburb') return [result];
        if(result?.ok&&result.type==='postcode') return result.suburbs;
        return [];
      });
      suburbResults.forEach(result=>{
        directSuburbNames.add(normaliseText(result.suburbName));
        addDirectSuburbMarker(result);
      });
      suburbData.setStyle(suburbFeatureStyle);
      defaultData.setStyle(defaultFeatureStyle);
      setSuburbTagsVisible(true);
      updateLegend();
      fitSearchResults();
      updateAddressMarkerSizes();

      const addressCount=results.filter(result=>result?.ok&&result.type==='address').length;
      const suburbCount=new Set(suburbResults.map(result=>normaliseText(result.suburbName))).size;
      const failures=results.filter(result=>!result?.ok);
      const notices=results.filter(result=>result?.notice);
      setSearchResult(
        '<div class="result-summary-grid">'+
          `<div class="result-metric"><strong>${addressCount}</strong><span>Address Pins</span></div>`+
          `<div class="result-metric"><strong>${suburbCount}</strong><span>Suburb</span></div>`+
          `<div class="result-metric"><strong>${selectedSuburbs.size}</strong><span>Highlighted Areas</span></div>`+
        '</div>',
        [
          ...notices.map(result=>`${result.input}: ${result.notice}`),
          ...failures.map(result=>`${result.input}: ${result.reason}`)
        ],
        failures.length===lines.length
      );
    }catch(error){
      console.error(error);
      setSearchResult(`Search failed: ${escapeHtml(error.message||'Unknown error')}`,[],true);
    }finally{
      searchButton.disabled=false;
      clearButton.disabled=false;
      updateBoundaryToggle();
      searchProgress.hidden=true;
    }
  }

  function showKeySetup(message='Enter a Google Maps API Key to start the map.'){
    statusElement.hidden=false;
    statusElement.className='status api-key-setup';
    statusElement.innerHTML=
      '<strong>Google Maps Setup</strong>'+
      `<p>${escapeHtml(message)}</p>`+
      '<div class="api-key-row"><input id="googleKeyInput" type="password" autocomplete="off" placeholder="AIza..."><button id="saveGoogleKey" type="button">Save and Start</button></div>'+
      '<span class="api-key-note">The key is stored only in this browser. Before publishing to GitHub, use a browser key in config.js that is restricted to your GitHub Pages domain.</span>';
    document.getElementById('saveGoogleKey').addEventListener('click',()=>{
      const key=document.getElementById('googleKeyInput').value.trim();
      if(!key) return;
      localStorage.setItem(KEY_STORAGE,key);
      location.reload();
    });
  }

  function loadGoogleMaps(){
    const key=String(window.GOOGLE_MAPS_API_KEY||localStorage.getItem(KEY_STORAGE)||'').trim();
    if(!key){
      showKeySetup();
      return;
    }
    window.initGoogleDeliveryMap=initialise;
    window.gm_authFailure=()=>{
      localStorage.removeItem(KEY_STORAGE);
      showKeySetup('The API key is invalid or this domain is not authorized. Check the Google Cloud settings.');
    };
    const script=document.createElement('script');
    script.async=true;
    script.defer=true;
    script.src='https://maps.googleapis.com/maps/api/js?'+new URLSearchParams({
      key,
      callback:'initGoogleDeliveryMap',
      v:'weekly',
      loading:'async',
      language:'en',
      region:'AU'
    });
    script.onerror=()=>showKeySetup('Google Maps failed to load. Check the network, API key and domain restrictions.');
    document.head.appendChild(script);
  }

  async function initialise(){
    try{
      map=new google.maps.Map(document.getElementById('map'),googleMapOptions());
      installPreciseScaleControl();
      if(roadIconMode==='custom'&&!cloudMapId){
        console.warn('Option 2 is using the normal vector basemap. Add GOOGLE_MAPS_MAP_ID in config.js to apply the cloud style that hides road numbers and POI icons.');
      }
      geocoder=new google.maps.Geocoder();
      infoWindow=new google.maps.InfoWindow();
      if(roadIconMode==='custom'&&cloudMapId){
        ({AdvancedMarkerElement}=await google.maps.importLibrary('marker'));
        markerProjection=new google.maps.OverlayView();
        markerProjection.onAdd=()=>{};
        markerProjection.draw=()=>requestAnimationFrame(layoutAddressLabels);
        markerProjection.onRemove=()=>{};
        markerProjection.setMap(map);
      }
      infoWindow.addListener('closeclick',()=>{infoOpen=false});
      map.addListener('click',event=>{
        closeInfo();
        if(event.placeId) return;
        clearPendingAddressSelections();
      });
      map.addListener('zoom_changed',()=>{
        defaultData?.setStyle(defaultFeatureStyle);
        suburbData?.setStyle(suburbFeatureStyle);
        updateAddressMarkerSizes();
        updatePostcodeLabels();
        updatePreciseScaleControl();
      });
      map.addListener('idle',()=>{
        requestAnimationFrame(layoutAddressLabels);
        updatePreciseScaleControl();
      });

      const areas=await loadAreas();
      setupDefaultLayer({
        type:'FeatureCollection',
        features:areas.features.filter(feature=>
          feature.properties?.boundary_type==='postcode'&&postcodeGroupColors[Number(feature.properties.group)]
        )
      });
      ensureSuburbLayer();
      await loadSuburbBoundaries();
      suburbData.setMap(null);
      suburbData.setStyle(suburbFeatureStyle);
      if(defaultBounds&&!defaultBounds.isEmpty()) map.fitBounds(defaultBounds,35);
      updateBoundaryToggle();
      updateLegend();
      if(roadIconMode==='custom'&&!cloudMapId){
        statusElement.hidden=false;
        statusElement.className='status';
        statusElement.innerHTML='<strong>High-resolution vector map enabled</strong><br>Add a vector Map ID to config.js so the cloud style can hide road shields and place icons while keeping airports.';
      }else{
        statusElement.hidden=true;
        statusElement.className='status';
      }
      searchButton.disabled=false;
      clearButton.disabled=false;
      window.parent?.postMessage({type:'BENTWAY_MAP_READY'},'*');
      if(queuedSystemShipmentPayload){
        const payload=queuedSystemShipmentPayload;
        queuedSystemShipmentPayload=null;
        importShipmentsFromSystem(payload);
      }
    }catch(error){
      console.error(error);
      statusElement.hidden=false;
      statusElement.className='status error';
      statusElement.textContent=`Map failed to load: ${error.message||'Unknown error'}`;
    }
  }

  panelToggle.addEventListener('click',()=>{
    const collapsed=searchPanel.classList.toggle('collapsed');
    panelToggle.textContent=collapsed?'+':'−';
    panelToggle.title=collapsed?'Expand':'Collapse';
    panelToggle.setAttribute('aria-label',collapsed?'Expand search panel':'Collapse search panel');
  });
  searchButton.addEventListener('click',runBatchSearch);
  clearButton.addEventListener('click',()=>resetSearch(true));
  boundaryToggleButton?.addEventListener('click',()=>setAllBoundariesVisible(!boundariesVisible));
  suburbTagToggleButton?.addEventListener('click',()=>setSuburbTagsVisible(!suburbTagsVisible));
  resultMarkButton?.addEventListener('click',applyPendingAddressMarks);
  sheetImportButton?.addEventListener('click',importAddressesFromGoogleSheets);
  searchInput.addEventListener('input',updateInputCount);
  searchInput.addEventListener('keydown',event=>{
    if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){
      event.preventDefault();
      runBatchSearch();
    }
  });
  updateInputCount();
  updateSuburbTagToggle();
  updateResultMarkButton();
  loadGoogleMaps();
})();
