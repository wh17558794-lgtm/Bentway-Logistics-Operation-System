-- SQL 30 - Require postcode and suburb to match the same V1-V4 delivery area
-- Executed in production on 2026-08-16. Do not run again.

begin;

create table if not exists private.delivery_postcode_suburbs (
  state text not null default 'VIC',
  postcode text not null,
  suburb text not null,
  constraint delivery_postcode_suburbs_pkey primary key (state, postcode, suburb),
  constraint delivery_postcode_suburbs_state_check check (btrim(state) <> ''),
  constraint delivery_postcode_suburbs_postcode_check check (btrim(postcode) <> ''),
  constraint delivery_postcode_suburbs_suburb_check check (btrim(suburb) <> '')
);

comment on table private.delivery_postcode_suburbs is
  'Official suburb names allowed for each delivery postcode; generated from data/delivery-areas.geojson.';

revoke all on table private.delivery_postcode_suburbs from public, anon, authenticated;

insert into private.delivery_postcode_suburbs (state, postcode, suburb)
values
('VIC', '3000', 'MELBOURNE'),
  ('VIC', '3002', 'EAST MELBOURNE'),
  ('VIC', '3003', 'WEST MELBOURNE'),
  ('VIC', '3004', 'MELBOURNE'),
  ('VIC', '3006', 'SOUTH WHARF'),
  ('VIC', '3006', 'SOUTHBANK'),
  ('VIC', '3008', 'DOCKLANDS'),
  ('VIC', '3011', 'FOOTSCRAY'),
  ('VIC', '3011', 'SEDDON'),
  ('VIC', '3012', 'BROOKLYN'),
  ('VIC', '3012', 'KINGSVILLE'),
  ('VIC', '3012', 'MAIDSTONE'),
  ('VIC', '3012', 'TOTTENHAM'),
  ('VIC', '3012', 'WEST FOOTSCRAY'),
  ('VIC', '3013', 'YARRAVILLE'),
  ('VIC', '3015', 'NEWPORT'),
  ('VIC', '3015', 'SOUTH KINGSVILLE'),
  ('VIC', '3015', 'SPOTSWOOD'),
  ('VIC', '3016', 'WILLIAMSTOWN NORTH'),
  ('VIC', '3016', 'WILLIAMSTOWN'),
  ('VIC', '3018', 'ALTONA'),
  ('VIC', '3018', 'SEAHOLME'),
  ('VIC', '3019', 'BRAYBROOK'),
  ('VIC', '3020', 'ALBION'),
  ('VIC', '3020', 'SUNSHINE NORTH'),
  ('VIC', '3020', 'SUNSHINE WEST'),
  ('VIC', '3020', 'SUNSHINE'),
  ('VIC', '3021', 'ALBANVALE'),
  ('VIC', '3021', 'KEALBA'),
  ('VIC', '3021', 'KINGS PARK'),
  ('VIC', '3021', 'ST ALBANS'),
  ('VIC', '3022', 'ARDEER'),
  ('VIC', '3023', 'BURNSIDE HEIGHTS'),
  ('VIC', '3023', 'BURNSIDE'),
  ('VIC', '3023', 'CAIRNLEA'),
  ('VIC', '3023', 'CAROLINE SPRINGS'),
  ('VIC', '3023', 'DEER PARK'),
  ('VIC', '3023', 'RAVENHALL'),
  ('VIC', '3024', 'FIELDSTONE'),
  ('VIC', '3024', 'MAMBOURIN'),
  ('VIC', '3024', 'MANOR LAKES'),
  ('VIC', '3024', 'MOUNT COTTRELL'),
  ('VIC', '3024', 'WYNDHAM VALE'),
  ('VIC', '3025', 'ALTONA NORTH'),
  ('VIC', '3026', 'DERRIMUT'),
  ('VIC', '3026', 'LAVERTON NORTH'),
  ('VIC', '3027', 'WILLIAMS LANDING'),
  ('VIC', '3028', 'ALTONA MEADOWS'),
  ('VIC', '3028', 'LAVERTON'),
  ('VIC', '3028', 'SEABROOK'),
  ('VIC', '3029', 'HOPPERS CROSSING'),
  ('VIC', '3029', 'TARNEIT'),
  ('VIC', '3029', 'TRUGANINA'),
  ('VIC', '3030', 'COCOROC'),
  ('VIC', '3030', 'POINT COOK'),
  ('VIC', '3030', 'QUANDONG'),
  ('VIC', '3030', 'WERRIBEE SOUTH'),
  ('VIC', '3030', 'WERRIBEE'),
  ('VIC', '3031', 'FLEMINGTON'),
  ('VIC', '3031', 'KENSINGTON'),
  ('VIC', '3032', 'ASCOT VALE'),
  ('VIC', '3032', 'MARIBYRNONG'),
  ('VIC', '3032', 'TRAVANCORE'),
  ('VIC', '3033', 'KEILOR EAST'),
  ('VIC', '3034', 'AVONDALE HEIGHTS'),
  ('VIC', '3036', 'KEILOR NORTH'),
  ('VIC', '3036', 'KEILOR'),
  ('VIC', '3037', 'CALDER PARK'),
  ('VIC', '3037', 'DELAHEY'),
  ('VIC', '3037', 'HILLSIDE (GREATER MELBOURNE)'),
  ('VIC', '3037', 'SYDENHAM'),
  ('VIC', '3037', 'TAYLORS HILL'),
  ('VIC', '3038', 'KEILOR DOWNS'),
  ('VIC', '3038', 'KEILOR LODGE'),
  ('VIC', '3038', 'TAYLORS LAKES'),
  ('VIC', '3039', 'MOONEE PONDS'),
  ('VIC', '3040', 'ABERFELDIE'),
  ('VIC', '3040', 'ESSENDON WEST'),
  ('VIC', '3040', 'ESSENDON'),
  ('VIC', '3041', 'ESSENDON FIELDS'),
  ('VIC', '3041', 'ESSENDON NORTH'),
  ('VIC', '3041', 'STRATHMORE HEIGHTS'),
  ('VIC', '3041', 'STRATHMORE'),
  ('VIC', '3042', 'AIRPORT WEST'),
  ('VIC', '3042', 'KEILOR PARK'),
  ('VIC', '3042', 'NIDDRIE'),
  ('VIC', '3043', 'GLADSTONE PARK'),
  ('VIC', '3043', 'GOWANBRAE'),
  ('VIC', '3043', 'TULLAMARINE'),
  ('VIC', '3044', 'PASCOE VALE SOUTH'),
  ('VIC', '3044', 'PASCOE VALE'),
  ('VIC', '3045', 'MELBOURNE AIRPORT'),
  ('VIC', '3046', 'GLENROY'),
  ('VIC', '3046', 'HADFIELD'),
  ('VIC', '3046', 'OAK PARK'),
  ('VIC', '3047', 'BROADMEADOWS'),
  ('VIC', '3047', 'DALLAS'),
  ('VIC', '3047', 'JACANA'),
  ('VIC', '3048', 'COOLAROO'),
  ('VIC', '3048', 'MEADOW HEIGHTS'),
  ('VIC', '3049', 'ATTWOOD'),
  ('VIC', '3049', 'WESTMEADOWS'),
  ('VIC', '3051', 'NORTH MELBOURNE'),
  ('VIC', '3052', 'PARKVILLE'),
  ('VIC', '3053', 'CARLTON'),
  ('VIC', '3054', 'CARLTON NORTH'),
  ('VIC', '3054', 'PRINCES HILL'),
  ('VIC', '3055', 'BRUNSWICK WEST'),
  ('VIC', '3056', 'BRUNSWICK'),
  ('VIC', '3057', 'BRUNSWICK EAST'),
  ('VIC', '3058', 'COBURG NORTH'),
  ('VIC', '3058', 'COBURG'),
  ('VIC', '3059', 'GREENVALE'),
  ('VIC', '3060', 'FAWKNER'),
  ('VIC', '3061', 'CAMPBELLFIELD'),
  ('VIC', '3062', 'SOMERTON'),
  ('VIC', '3063', 'OAKLANDS JUNCTION'),
  ('VIC', '3063', 'YUROKE'),
  ('VIC', '3064', 'CRAIGIEBURN'),
  ('VIC', '3064', 'DONNYBROOK'),
  ('VIC', '3064', 'KALKALLO'),
  ('VIC', '3064', 'MICKLEHAM'),
  ('VIC', '3064', 'ROXBURGH PARK'),
  ('VIC', '3065', 'FITZROY'),
  ('VIC', '3066', 'COLLINGWOOD'),
  ('VIC', '3067', 'ABBOTSFORD'),
  ('VIC', '3068', 'CLIFTON HILL'),
  ('VIC', '3068', 'FITZROY NORTH'),
  ('VIC', '3070', 'NORTHCOTE'),
  ('VIC', '3071', 'THORNBURY'),
  ('VIC', '3072', 'PRESTON'),
  ('VIC', '3073', 'RESERVOIR'),
  ('VIC', '3074', 'THOMASTOWN'),
  ('VIC', '3075', 'LALOR'),
  ('VIC', '3076', 'EPPING'),
  ('VIC', '3078', 'ALPHINGTON'),
  ('VIC', '3078', 'FAIRFIELD'),
  ('VIC', '3079', 'IVANHOE EAST'),
  ('VIC', '3079', 'IVANHOE'),
  ('VIC', '3081', 'BELLFIELD (GREATER MELBOURNE)'),
  ('VIC', '3081', 'HEIDELBERG HEIGHTS'),
  ('VIC', '3081', 'HEIDELBERG WEST'),
  ('VIC', '3082', 'MILL PARK'),
  ('VIC', '3083', 'BUNDOORA'),
  ('VIC', '3083', 'KINGSBURY'),
  ('VIC', '3084', 'EAGLEMONT'),
  ('VIC', '3084', 'HEIDELBERG'),
  ('VIC', '3084', 'ROSANNA'),
  ('VIC', '3084', 'VIEWBANK'),
  ('VIC', '3085', 'MACLEOD'),
  ('VIC', '3085', 'YALLAMBIE'),
  ('VIC', '3087', 'WATSONIA NORTH'),
  ('VIC', '3087', 'WATSONIA'),
  ('VIC', '3088', 'BRIAR HILL'),
  ('VIC', '3088', 'GREENSBOROUGH'),
  ('VIC', '3088', 'ST HELENA'),
  ('VIC', '3089', 'DIAMOND CREEK'),
  ('VIC', '3090', 'PLENTY'),
  ('VIC', '3091', 'YARRAMBAT'),
  ('VIC', '3093', 'LOWER PLENTY'),
  ('VIC', '3094', 'MONTMORENCY'),
  ('VIC', '3095', 'ELTHAM NORTH'),
  ('VIC', '3095', 'ELTHAM'),
  ('VIC', '3095', 'RESEARCH'),
  ('VIC', '3096', 'WATTLE GLEN'),
  ('VIC', '3097', 'BEND OF ISLANDS'),
  ('VIC', '3097', 'KANGAROO GROUND'),
  ('VIC', '3097', 'WATSONS CREEK'),
  ('VIC', '3101', 'KEW'),
  ('VIC', '3102', 'KEW EAST'),
  ('VIC', '3103', 'BALWYN'),
  ('VIC', '3103', 'DEEPDENE'),
  ('VIC', '3104', 'BALWYN NORTH'),
  ('VIC', '3105', 'BULLEEN'),
  ('VIC', '3106', 'TEMPLESTOWE'),
  ('VIC', '3107', 'TEMPLESTOWE LOWER'),
  ('VIC', '3108', 'DONCASTER'),
  ('VIC', '3109', 'DONCASTER EAST'),
  ('VIC', '3111', 'DONVALE'),
  ('VIC', '3113', 'NORTH WARRANDYTE'),
  ('VIC', '3113', 'WARRANDYTE'),
  ('VIC', '3114', 'PARK ORCHARDS'),
  ('VIC', '3115', 'WONGA PARK'),
  ('VIC', '3121', 'BURNLEY'),
  ('VIC', '3121', 'CREMORNE'),
  ('VIC', '3121', 'RICHMOND'),
  ('VIC', '3122', 'HAWTHORN'),
  ('VIC', '3123', 'HAWTHORN EAST'),
  ('VIC', '3124', 'CAMBERWELL'),
  ('VIC', '3125', 'BURWOOD'),
  ('VIC', '3126', 'CANTERBURY'),
  ('VIC', '3127', 'MONT ALBERT'),
  ('VIC', '3127', 'SURREY HILLS'),
  ('VIC', '3128', 'BOX HILL SOUTH'),
  ('VIC', '3128', 'BOX HILL'),
  ('VIC', '3129', 'BOX HILL NORTH'),
  ('VIC', '3129', 'MONT ALBERT NORTH'),
  ('VIC', '3130', 'BLACKBURN NORTH'),
  ('VIC', '3130', 'BLACKBURN SOUTH'),
  ('VIC', '3130', 'BLACKBURN'),
  ('VIC', '3131', 'FOREST HILL'),
  ('VIC', '3131', 'NUNAWADING'),
  ('VIC', '3132', 'MITCHAM'),
  ('VIC', '3133', 'VERMONT SOUTH'),
  ('VIC', '3133', 'VERMONT'),
  ('VIC', '3134', 'RINGWOOD NORTH'),
  ('VIC', '3134', 'RINGWOOD'),
  ('VIC', '3134', 'WARRANDYTE SOUTH'),
  ('VIC', '3134', 'WARRANWOOD'),
  ('VIC', '3135', 'HEATHMONT'),
  ('VIC', '3135', 'RINGWOOD EAST'),
  ('VIC', '3136', 'CROYDON HILLS'),
  ('VIC', '3136', 'CROYDON NORTH'),
  ('VIC', '3136', 'CROYDON SOUTH'),
  ('VIC', '3136', 'CROYDON'),
  ('VIC', '3137', 'KILSYTH SOUTH'),
  ('VIC', '3137', 'KILSYTH'),
  ('VIC', '3138', 'MOOROOLBARK'),
  ('VIC', '3141', 'SOUTH YARRA'),
  ('VIC', '3142', 'TOORAK'),
  ('VIC', '3143', 'ARMADALE'),
  ('VIC', '3144', 'KOOYONG'),
  ('VIC', '3144', 'MALVERN'),
  ('VIC', '3145', 'CAULFIELD EAST'),
  ('VIC', '3145', 'MALVERN EAST'),
  ('VIC', '3146', 'GLEN IRIS'),
  ('VIC', '3147', 'ASHBURTON'),
  ('VIC', '3147', 'ASHWOOD'),
  ('VIC', '3148', 'CHADSTONE'),
  ('VIC', '3149', 'MOUNT WAVERLEY'),
  ('VIC', '3150', 'GLEN WAVERLEY'),
  ('VIC', '3150', 'WHEELERS HILL'),
  ('VIC', '3151', 'BURWOOD EAST'),
  ('VIC', '3152', 'WANTIRNA SOUTH'),
  ('VIC', '3152', 'WANTIRNA'),
  ('VIC', '3153', 'BAYSWATER NORTH'),
  ('VIC', '3153', 'BAYSWATER'),
  ('VIC', '3154', 'THE BASIN'),
  ('VIC', '3155', 'BORONIA'),
  ('VIC', '3156', 'FERNTREE GULLY'),
  ('VIC', '3156', 'LYSTERFIELD SOUTH'),
  ('VIC', '3156', 'LYSTERFIELD'),
  ('VIC', '3156', 'UPPER FERNTREE GULLY'),
  ('VIC', '3158', 'UPWEY'),
  ('VIC', '3160', 'BELGRAVE HEIGHTS'),
  ('VIC', '3160', 'BELGRAVE SOUTH'),
  ('VIC', '3160', 'BELGRAVE'),
  ('VIC', '3160', 'TECOMA'),
  ('VIC', '3161', 'CAULFIELD NORTH'),
  ('VIC', '3162', 'CAULFIELD SOUTH'),
  ('VIC', '3162', 'CAULFIELD'),
  ('VIC', '3163', 'CARNEGIE'),
  ('VIC', '3163', 'GLEN HUNTLY'),
  ('VIC', '3163', 'MURRUMBEENA'),
  ('VIC', '3165', 'BENTLEIGH EAST'),
  ('VIC', '3166', 'HUGHESDALE'),
  ('VIC', '3166', 'HUNTINGDALE'),
  ('VIC', '3166', 'OAKLEIGH EAST'),
  ('VIC', '3166', 'OAKLEIGH'),
  ('VIC', '3167', 'OAKLEIGH SOUTH'),
  ('VIC', '3168', 'CLAYTON'),
  ('VIC', '3168', 'NOTTING HILL'),
  ('VIC', '3169', 'CLARINDA'),
  ('VIC', '3169', 'CLAYTON SOUTH'),
  ('VIC', '3170', 'MULGRAVE'),
  ('VIC', '3171', 'SPRINGVALE'),
  ('VIC', '3172', 'DINGLEY VILLAGE'),
  ('VIC', '3172', 'SPRINGVALE SOUTH'),
  ('VIC', '3173', 'KEYSBOROUGH'),
  ('VIC', '3174', 'NOBLE PARK NORTH'),
  ('VIC', '3174', 'NOBLE PARK'),
  ('VIC', '3175', 'BANGHOLME'),
  ('VIC', '3175', 'DANDENONG NORTH'),
  ('VIC', '3175', 'DANDENONG SOUTH'),
  ('VIC', '3175', 'DANDENONG'),
  ('VIC', '3177', 'DOVETON'),
  ('VIC', '3177', 'EUMEMMERRING'),
  ('VIC', '3178', 'ROWVILLE'),
  ('VIC', '3179', 'SCORESBY'),
  ('VIC', '3180', 'KNOXFIELD'),
  ('VIC', '3181', 'PRAHRAN'),
  ('VIC', '3181', 'WINDSOR'),
  ('VIC', '3182', 'ST KILDA WEST'),
  ('VIC', '3182', 'ST KILDA'),
  ('VIC', '3183', 'BALACLAVA'),
  ('VIC', '3183', 'ST KILDA EAST'),
  ('VIC', '3184', 'ELWOOD'),
  ('VIC', '3185', 'ELSTERNWICK'),
  ('VIC', '3185', 'GARDENVALE'),
  ('VIC', '3185', 'RIPPONLEA'),
  ('VIC', '3186', 'BRIGHTON'),
  ('VIC', '3187', 'BRIGHTON EAST'),
  ('VIC', '3188', 'HAMPTON EAST'),
  ('VIC', '3188', 'HAMPTON'),
  ('VIC', '3189', 'MOORABBIN'),
  ('VIC', '3190', 'HIGHETT'),
  ('VIC', '3191', 'SANDRINGHAM'),
  ('VIC', '3192', 'CHELTENHAM'),
  ('VIC', '3193', 'BEAUMARIS'),
  ('VIC', '3193', 'BLACK ROCK'),
  ('VIC', '3194', 'MENTONE'),
  ('VIC', '3194', 'MOORABBIN AIRPORT'),
  ('VIC', '3195', 'ASPENDALE GARDENS'),
  ('VIC', '3195', 'ASPENDALE'),
  ('VIC', '3195', 'BRAESIDE'),
  ('VIC', '3195', 'MORDIALLOC'),
  ('VIC', '3195', 'PARKDALE'),
  ('VIC', '3195', 'WATERWAYS'),
  ('VIC', '3196', 'BONBEACH'),
  ('VIC', '3196', 'CHELSEA HEIGHTS'),
  ('VIC', '3196', 'CHELSEA'),
  ('VIC', '3196', 'EDITHVALE'),
  ('VIC', '3197', 'CARRUM'),
  ('VIC', '3197', 'PATTERSON LAKES'),
  ('VIC', '3198', 'SEAFORD'),
  ('VIC', '3199', 'FRANKSTON SOUTH'),
  ('VIC', '3199', 'FRANKSTON'),
  ('VIC', '3200', 'FRANKSTON NORTH'),
  ('VIC', '3201', 'CARRUM DOWNS'),
  ('VIC', '3202', 'HEATHERTON'),
  ('VIC', '3204', 'BENTLEIGH'),
  ('VIC', '3204', 'MCKINNON'),
  ('VIC', '3204', 'ORMOND'),
  ('VIC', '3205', 'SOUTH MELBOURNE'),
  ('VIC', '3206', 'ALBERT PARK'),
  ('VIC', '3206', 'MIDDLE PARK'),
  ('VIC', '3207', 'PORT MELBOURNE'),
  ('VIC', '3335', 'BONNIE BROOK'),
  ('VIC', '3335', 'GRANGEFIELDS'),
  ('VIC', '3335', 'PLUMPTON'),
  ('VIC', '3335', 'ROCKBANK'),
  ('VIC', '3335', 'THORNHILL PARK'),
  ('VIC', '3336', 'AINTREE'),
  ('VIC', '3336', 'DEANSIDE'),
  ('VIC', '3336', 'FRASER RISE'),
  ('VIC', '3337', 'HARKNESS'),
  ('VIC', '3337', 'KURUNJANG'),
  ('VIC', '3337', 'MELTON WEST'),
  ('VIC', '3337', 'MELTON'),
  ('VIC', '3337', 'TOOLERN VALE'),
  ('VIC', '3338', 'BROOKFIELD'),
  ('VIC', '3338', 'COBBLEBANK'),
  ('VIC', '3338', 'EXFORD'),
  ('VIC', '3338', 'EYNESBURY'),
  ('VIC', '3338', 'MELTON SOUTH'),
  ('VIC', '3338', 'STRATHTULLOH'),
  ('VIC', '3338', 'WEIR VIEWS'),
  ('VIC', '3427', 'DIGGERS REST'),
  ('VIC', '3428', 'BULLA'),
  ('VIC', '3429', 'SUNBURY'),
  ('VIC', '3429', 'WILDWOOD'),
  ('VIC', '3750', 'WOLLERT'),
  ('VIC', '3752', 'SOUTH MORANG'),
  ('VIC', '3754', 'DOREEN'),
  ('VIC', '3754', 'MERNDA'),
  ('VIC', '3756', 'CHINTIN'),
  ('VIC', '3756', 'DARRAWEIT GUIM'),
  ('VIC', '3756', 'UPPER PLENTY'),
  ('VIC', '3756', 'WALLAN'),
  ('VIC', '3765', 'MONTROSE'),
  ('VIC', '3785', 'TREMONT'),
  ('VIC', '3802', 'ENDEAVOUR HILLS'),
  ('VIC', '3803', 'HALLAM'),
  ('VIC', '3804', 'NARRE WARREN EAST'),
  ('VIC', '3804', 'NARRE WARREN NORTH'),
  ('VIC', '3805', 'NARRE WARREN SOUTH'),
  ('VIC', '3805', 'NARRE WARREN'),
  ('VIC', '3806', 'BERWICK'),
  ('VIC', '3806', 'HARKAWAY'),
  ('VIC', '3807', 'BEACONSFIELD'),
  ('VIC', '3807', 'GUYS HILL'),
  ('VIC', '3808', 'BEACONSFIELD UPPER'),
  ('VIC', '3808', 'DEWHURST'),
  ('VIC', '3809', 'OFFICER SOUTH'),
  ('VIC', '3809', 'OFFICER'),
  ('VIC', '3810', 'PAKENHAM SOUTH'),
  ('VIC', '3810', 'PAKENHAM UPPER'),
  ('VIC', '3810', 'PAKENHAM'),
  ('VIC', '3810', 'RYTHDALE'),
  ('VIC', '3910', 'LANGWARRIN'),
  ('VIC', '3911', 'BAXTER'),
  ('VIC', '3911', 'LANGWARRIN SOUTH'),
  ('VIC', '3921', 'ELIZABETH ISLAND'),
  ('VIC', '3921', 'FRENCH ISLAND'),
  ('VIC', '3930', 'MOUNT ELIZA'),
  ('VIC', '3975', 'LYNBROOK'),
  ('VIC', '3975', 'LYNDHURST'),
  ('VIC', '3976', 'HAMPTON PARK'),
  ('VIC', '3977', 'BOTANIC RIDGE'),
  ('VIC', '3977', 'CANNONS CREEK'),
  ('VIC', '3977', 'CRANBOURNE EAST'),
  ('VIC', '3977', 'CRANBOURNE NORTH'),
  ('VIC', '3977', 'CRANBOURNE SOUTH'),
  ('VIC', '3977', 'CRANBOURNE WEST'),
  ('VIC', '3977', 'CRANBOURNE'),
  ('VIC', '3977', 'DEVON MEADOWS'),
  ('VIC', '3977', 'JUNCTION VILLAGE'),
  ('VIC', '3977', 'SANDHURST'),
  ('VIC', '3977', 'SKYE'),
  ('VIC', '3978', 'CARDINIA'),
  ('VIC', '3978', 'CLYDE NORTH'),
  ('VIC', '3978', 'CLYDE')
on conflict (state, postcode, suburb) do nothing;

create or replace function public.assign_shipment_suburb_rate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate public.delivery_suburb_rates%rowtype;
begin
  select rate.*
  into v_rate
  from public.delivery_suburb_rates as rate
  where rate.is_active = true
    and upper(btrim(rate.zone)) in ('V1', 'V2', 'V3', 'V4')
    and upper(btrim(rate.state)) = upper(btrim(coalesce(new.state, 'VIC')))
    and nullif(btrim(new.postcode), '') is not null
    and btrim(rate.postcode) = btrim(new.postcode)
    and nullif(btrim(new.suburb), '') is not null
    and exists (
      select 1
      from private.delivery_postcode_suburbs as mapping
      where mapping.state = upper(btrim(coalesce(new.state, 'VIC')))
        and mapping.postcode = btrim(new.postcode)
        and mapping.suburb = upper(btrim(new.suburb))
    )
    and rate.effective_from <= (now() at time zone 'Australia/Melbourne')::date
    and (rate.effective_to is null or rate.effective_to >= (now() at time zone 'Australia/Melbourne')::date)
  order by rate.effective_from desc
  limit 1;

  if found then
    new.delivery_rate_id := v_rate.id;
    new.unit_price := v_rate.unit_price;
    new.fuel_levy_rate := v_rate.fuel_levy_rate;
    new.gst_rate := v_rate.gst_rate;
  else
    new.delivery_rate_id := null;
    new.unit_price := null;
  end if;

  return new;
end;
$$;

revoke all on function public.assign_shipment_suburb_rate() from public, anon, authenticated;

create or replace function public.refresh_shipment_exceptions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated_count integer;
  v_today date := (now() at time zone 'Australia/Melbourne')::date;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not private.has_any_role(array['admin', 'operations', 'warehouse']::text[]) then
    raise exception 'Permission denied';
  end if;

  with candidates as materialized (
    select
      shipment.id,
      shipment.current_status as previous_status,
      concat_ws(E'\n',
        case when not exists (
          select 1
          from public.delivery_suburb_rates as rate
          where rate.is_active = true
            and upper(btrim(rate.zone)) in ('V1', 'V2', 'V3', 'V4')
            and upper(btrim(rate.state)) = upper(btrim(coalesce(shipment.state, 'VIC')))
            and nullif(btrim(shipment.postcode), '') is not null
            and btrim(rate.postcode) = btrim(shipment.postcode)
            and nullif(btrim(shipment.suburb), '') is not null
            and exists (
              select 1
              from private.delivery_postcode_suburbs as mapping
              where mapping.state = upper(btrim(coalesce(shipment.state, 'VIC')))
                and mapping.postcode = btrim(shipment.postcode)
                and mapping.suburb = upper(btrim(shipment.suburb))
            )
            and rate.effective_from <= v_today
            and (rate.effective_to is null or rate.effective_to >= v_today)
        ) then format(
          'Postcode/suburb pair is outside V1-V4 delivery areas: %s %s %s.',
          coalesce(nullif(btrim(shipment.suburb), ''), '/'),
          coalesce(nullif(upper(btrim(shipment.state)), ''), '/'),
          coalesce(nullif(btrim(shipment.postcode), ''), '/')
        ) end,
        case when shipment.current_status = 'scheduled'
          and shipment.scheduled_for is not null
          and (shipment.scheduled_for at time zone 'Australia/Melbourne')::date < v_today
        then format(
          'Scheduled On date %s has passed without changing to Out Of Delivery.',
          to_char(shipment.scheduled_for at time zone 'Australia/Melbourne', 'DD Mon YYYY')
        ) end
      ) as reason
    from public.shipments as shipment
    where shipment.cancelled_at is null
      and shipment.current_status not in ('completed', 'cancelled', 'exception')
  ),
  updated as (
    update public.shipments as shipment
    set current_status = 'exception',
        exception_reason = candidates.reason,
        exception_resolution_reason = null,
        updated_at = now()
    from candidates
    where shipment.id = candidates.id
      and shipment.current_status = candidates.previous_status
      and nullif(candidates.reason, '') is not null
    returning shipment.id, candidates.previous_status, candidates.reason
  ),
  logged as (
    insert into public.shipment_events (
      shipment_id,
      event_type,
      from_status,
      to_status,
      event_at,
      performed_by,
      notes,
      metadata
    )
    select
      updated.id,
      'exception',
      updated.previous_status,
      'exception',
      now(),
      auth.uid(),
      updated.reason,
      jsonb_build_object('automatic', true, 'exception_reason', updated.reason)
    from updated
  )
  select count(*)::integer into v_updated_count from updated;

  return v_updated_count;
end;
$$;

revoke all on function public.refresh_shipment_exceptions() from public, anon;
grant execute on function public.refresh_shipment_exceptions() to authenticated;

commit;
