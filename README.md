# BentWay Logistics Operations System

BentWay 的仓库入仓、待处理货物、完成记录、计费与 Melbourne 配送地图系统。
项目是可直接部署到 GitHub Pages 的静态网页，业务数据和员工登录由 Supabase 提供。

## 当前状态

- Supabase 生产项目和数据库已在使用。
- SQL 07–31 已执行；不要重复运行，也不要重建数据库。
- GitHub Pages 已启用，部署时保留现有相对路径和静态文件结构。
- 当前前端不需要 npm 安装或构建步骤。

## 已完成功能

- Supabase 邮箱登录、员工资料和角色权限。
- 客户资料关联，以及手工、Excel、CSV 入仓。
- Pending Shipments A/B 表格、搜索、状态筛选和多选操作。
- Pending Shipments 与 Shipment History 均支持复选框、Ctrl 单选和 Ctrl+鼠标拖动连续选择/取消。
- Shipment History 统一字体，并支持批量 Resume 和软删除。
- Pending Shipments 与 Shipment History 均可按 Esc 清空全部选择。
- 两页顶栏在普通搜索筛选工具与已选货物批量操作之间平滑切换。
- 两页均可通过垂直切换按钮翻转时间排序，Pending 仍保留状态分组位置。
- Delivered、Picked Up、DTW、Return 和管理员软删除（界面隐藏，数据库保留）。
- Pending、Message Sent、Scheduled On、On Hold、Pending Warehouse Booking、Out Of Delivery 状态流程。
- Prepare SMS 可从 Pending 快捷键、批量操作栏或详情弹窗触发；系统会记录准备时间与操作人并将状态改为 Message Sent。手动选择 Message Sent 不会触发短信准备。
- 预约日期提示与逾期提醒。
- Melbourne 邮编优先计价、V1–V4 单价、Fuel Levy、GST、尾板费和吊车费。
- Pending Warehouse Booking 固定 $150，且数据库和前端均禁用吊车服务。
- Shipment Details 支持记录应到总件数；实到 Quantity 与 Total Quantity 不同时，B-X/B-Y 的 QTY 显示为“实到/应到”。
- Fuel Levy 与 Total Charge 手工覆盖；清空后恢复自动计算。
- Google Maps 地址、suburb、postcode 批量定位和本地 GeoJSON 边界。
- Google Sheets 地址导入，以及独立的 Delivering/Delivered 工作表自动化脚本。

## 本地运行

双击 `START-BENTWAY-SYSTEM.cmd`，然后打开 `http://localhost:8080/`。详细说明见
[`SYSTEM_SETUP.md`](SYSTEM_SETUP.md)。

地图的 Google Maps 浏览器 key 必须限制到本地或 GitHub Pages 域名，并仅启用所需
API。Supabase 网页配置只能使用 publishable key，绝不能放入 secret、service-role、
数据库密码或连接字符串。

## GitHub Pages 部署

发布整个目录，至少要包含：

- `index.html`、`app.js`、`app.css`、`operations-ui.css`
- `map.html`、`google-app.js`、`operations-map-ui.css`
- `config.js`、`supabase-config.js`
- `assets/` 与 `data/`

发布后强制刷新一次，以加载更新后的带版本号静态资源。

## 数据库脚本

`07_*.sql` 至 `23_*.sql` 是已上线的增量记录，涵盖客户、货物管理、状态流程、
Melbourne 价格、仓库预约、吊车和计费修正。它们保留用于审计或重建其他数据库，
不是当前生产环境的启动步骤。

`24_resume_completed_shipments.sql` 是 Shipment History 批量恢复所需的新增函数，核对后仅执行一次；不要重跑 07–23。

`25_add_v2_postcode_3004.sql` 将 postcode 3004 加入 V2（$40/m³），并仅刷新该邮编下未完成货物的价格；核对后仅执行一次。

`26_minimum_billable_volume.sql` 将标准货物的最低计费体积设为 1 m³（原始 Volume 不变）；核对后仅执行一次，不要重跑 07–25。

`27_sync_minimum_billable_volume.sql` 同步修正 Fuel Levy 与 Total Charge 的数据库生成公式，让列表和详情弹窗都按最低 1 m³ 计费；可直接执行，无需重跑 07–26。

`28_add_total_quantity.sql` 已于 2026-08-15 在生产数据库执行，为货物增加可选的应到总件数字段和“应到不得少于实到”的约束；脚本没有回填、删除或批量修改现有货物，不要重复执行。

`29_add_automatic_shipment_exceptions.sql` 已于 2026-08-16 在生产数据库执行。它增加异常原因与解除原因，限制 Exception 只能在 Shipment Details 中人工变更，并在页面加载/刷新时根据 V1–V4 运价范围和过期 Scheduled On 日期自动判定异常；不要重复执行。

`30_require_matching_postcode_suburb.sql` 已于 2026-08-16 在生产数据库执行。它将本地配送边界中的 207 个 postcode、402 个正式 suburb 对应关系写入私有映射表，并让计价与自动异常判定都要求 State、Postcode、Suburb 在同一配送区域记录中匹配。不要重复执行。

`31_add_message_sent_and_sms_preparation.sql` 已于 2026-08-16 在生产数据库执行。它增加 Message Sent 状态与事件类型，并提供原子 RPC，在系统准备短信时记录 `sms_prepared_at`、`sms_prepared_by` 和状态事件；没有修改现有货物数据。不要重复执行。

任何新数据库改动都必须先核对线上 schema、函数、触发器和 RLS，再使用新的顺序编号；
不得覆盖或重跑 07–23。

## 主要文件

- `index.html` / `app.js`：运营系统界面与 Supabase 数据操作。
- `map.html` / `google-app.js`：配送地图与批量地址搜索。
- `data/delivery-areas.geojson`：当前地图使用的邮编和 suburb 边界。
- `google-sheets-delivery-automation.gs`：Google Sheets 行移动与恢复自动化。
- `README.txt`：原地图生成与布局说明，保留供边界维护参考。
- `CODEX_HANDOFF_2026-08-14.md`：2026-08-14 的历史交接快照。

## 最小验证

```powershell
node --check app.js
node --check google-app.js
```

数据库与登录流程的最终验证必须使用测试账号和测试货物在已配置环境中完成。
