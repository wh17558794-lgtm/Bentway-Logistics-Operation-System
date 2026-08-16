Google Maps 路线测试版
====================

首次生成本地边界
----------------
1. 双击 build-local-boundaries.cmd。
2. 浏览器打开边界生成器后，点击“开始生成本地边界”。
3. 保持页面和最小化的服务器窗口开启，直到进度达到 100%。
4. 工具会自动生成：
   data/delivery-areas.geojson
   data/suburb-boundaries.geojson
5. 这一步只需执行一次。以后地图不会再向 Vicmap 请求边界。

扩展到 650 个 suburb
---------------------
1. 先完成上述 334 个配送相关 suburb 的首次生成。
2. 双击 expand-suburbs-to-650.cmd。
3. 点击“开始扩展至 650 个”，等待进度达到 100%。
4. 工具保留原 334 个，完整包含截图覆盖的 Melbourne、Geelong、Bacchus Marsh、Yarra Valley、Officer 和 Frankston 范围，再补足至 650 个。
5. 地图默认显示全部 650 个 suburb 的中性边界；搜索区域统一使用蓝色高亮。

本地测试
--------
1. 在 Google Cloud 启用 Maps JavaScript API 和 Geocoding API，并启用结算。
2. 双击 start-local-preview.cmd。
3. 浏览器打开 http://localhost:8080/。
4. 在页面提示框中输入 API Key；Key 只保存在当前浏览器。
5. 本地测试 Key 的网站限制应允许 http://localhost:8080/*。

GitHub Pages
------------
1. 上传本目录中的 index.html、google-app.js、config.js，以及整个 data 文件夹。
2. 把 config.js 中的空字符串替换成用于网站的浏览器 API Key。
3. 在 Google Cloud 中将 Key 限制到 GitHub Pages 域名。
4. API 限制只保留 Maps JavaScript API 和 Geocoding API。
5. 不要上传没有网站限制和 API 限制的 Key。

文件说明
--------
index.html                    Google 地图页面
google-app.js                 Google Maps、Google Geocoder 和批量搜索
config.js                     GitHub Pages 的 API Key 配置
data/delivery-areas.geojson   本地配送邮编边界
data/suburb-boundaries.geojson 本地 suburb 边界及配送区域分类
build-local-boundaries.cmd    一次性边界生成器
prepare-local-boundaries.html 边界生成器界面
expand-suburbs-to-650.cmd      334→650 一次性扩展工具
expand-suburbs-to-500.html     650 个 suburb 扩展界面（内部页面文件）
preview_server.py             仅用于把生成结果保存到本机
start-local-preview.cmd       本地地图启动器

当前结构
--------
- 底图：Google Maps JavaScript API
- 具体地址定位：Google Geocoder（在线）
- 邮编和 suburb 边界：本地 GeoJSON（生成后完全离线）
- Unit、Apartment、Level、Lot 和斜线前单位号会在查询前自动删除
- 地图右下角显示自定义精确比例尺，并按当前缩放和纬度保留一位小数
- 右下角图例在上、比例尺在下，整组固定为 right 69px / bottom 30px
- 使用 ?layout-edit=1 可拖动图例与比例尺，并显示 right/bottom 定位数值
- 搜索完成后自动包含全部结果并额外缩小一级，保留墨尔本方位背景
- 地址结果的 Suburb 名称标签默认开启
- 按住 Ctrl 点击搜索结果的 Suburb 区域时，如果区域内只有一个地址，
  可以直接选中或取消选中该地址；区域内有多个地址时仍需点击具体水滴或标签
- 点击 Suburb 区域的信息窗会列出该区域当前搜索结果中的具体地址
- 同时选中已标记和未标记地址时，“切换标记状态”会分别反转每个地址的状态
- 已标记地址被暂时选中时使用红色光圈，未标记地址继续使用蓝色光圈
- 至少一个地址被暂时选中时，点击空白底图会取消全部暂时选择
- Suburb 地址标签使用接近 Google Maps 的清晰字体，并取消背景模糊滤镜
- 所有地图信息窗统一使用原生标题栏；无标题时自动移除标题栏，避免顶部留白
- 原 Leaflet 版本没有被覆盖
