# BentWay Logistics Operations System

BentWay 的仓库入仓、待处理货物、完成记录、计费与 Melbourne 配送地图系统。
项目是可直接部署到 GitHub Pages 的静态网页，业务数据和员工登录由 Supabase 提供。

## 当前状态

- Supabase 生产项目和数据库已在使用。
- README 旧记录称 SQL 07–31 已执行；2026-08-21 只读核对发现 production migration history 实际登记为 10–23、28–31。24–27 的部分 schema 效果存在，但 `resume_completed_shipment()` 不存在。旧脚本仍不得重跑；应先由数据库负责人核对并补齐 migration history。
- SQL 32–35 已于 2026-08-25、SQL 36 已于 2026-08-26 在 production 执行并登记 migration history；禁止修改或重跑，后续数据库变更从 SQL 37 开始。
- GitHub Pages 已启用，部署时保留现有相对路径和静态文件结构。
- 当前前端不需要 npm 安装或构建步骤。

## 已完成功能

- Supabase 邮箱登录、员工资料和角色权限。
- 客户资料关联，以及手工、Excel、CSV 入仓。
- Pending Shipments Operations View (OV) / Billing View (BV)、搜索、状态筛选和多选操作。
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
- Pending Warehouse Booking 默认 $150 ex GST，可用图标在 $150 / $200 间切换或手工输入其他合法税前金额，且数据库和前端均禁用吊车服务。
- Shipment Details 支持记录应到总件数；实到 Quantity 与 Total Quantity 不同时，OV/BV 的 QTY 显示为“实到/应到”。
- Fuel Levy 保留手工覆盖；普通 Shipment Total Charge 由数据库公式维护，Pending Warehouse Booking 保留最终金额手工覆盖。
- Shipment Details 使用半屏双栏工作区：左侧 Overview/Operations，右侧 Billing/Activity，两栏独立滚动；Crane Service 只在 Operations 编辑。
- Billing Workspace 按 Shipment 单行显示当前 Outstanding（含税）金额；已 Billed 历史只读且不会重复计入，新增 Storage 或 supplementary Crane 会让 Fully Billed Shipment 自动重新出现。
- Admin 顶层 Billing Profiles 页面维护客户公司/账单资料及 Tail Lift、Fuel、Storage、GST、Warehouse Booking、Minimum Volume、Pickup 默认值；浏览器只能通过 Admin RPC 保存。
- Picked Up 使用 Shipment 快照费率计算 `Weight × Pickup Rate`；Winmav 与 Oreo 当前默认均为 `$0.20/kg ex GST`，不加入 Delivery Volume、Tail Lift、Fuel Levy 或 Crane。
- Storage Start Date 与 Inbound Time 分开；进入 On Hold 立即按 Episode 的 Volume/Rate/GST 快照补齐当前所有完整周，历史 Billed 周以 earliest-first credit 覆盖修订后的 schedule。
- Draft Bill 是唯一的 Billing Editor，可继续 Add、Remove、编辑 Actual components；Expected 在加入 Draft 时冻结，Draft Save 不回写 Shipment/Storage/Crane/Container 来源数据，但会写入 Shipment Activity。只有原子 Finalise 成功后来源收费才标记 Billed。
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

- `index.html`、`app.js`、`billing-logic.js`、`app.css`、`operations-ui.css`
- `map.html`、`google-app.js`、`operations-map-ui.css`
- `config.js`、`supabase-config.js`
- `assets/` 与 `data/`

发布后强制刷新一次，以加载更新后的带版本号静态资源。

## Billing 三层金额模型

- Expected Charge：Shipment、Storage、Crane supplementary、Container source 当前业务数据计算出的预期收费。
- Draft Actual：收费加入唯一 Draft 时冻结 Expected baseline；Billing Editor 的 Qty、Rate、component Add/Remove 只持久化到 `billing_items.snapshot.actual_components` 与顶层 Actual amounts。
- Actual Billed：原子 Finalise 后的 Billing Item Actual。Finalised row 不可修改，Billing Status = Billed 只读取该历史快照，不用后来变化的 Shipment 重算。

Draft Save 不修改 Shipment Expected。Shipment Details 的 Billing Adjustments 区域显示 Expected、Actual、Difference 与 Draft/Finalised/Unbilled 状态；Activity 保存 source、Bill ID、Expected、before/after Actual、adjustment、操作人和时间。
Storage 的数据库记录仍是一周一条；Billing/Draft 的用户文案统一使用 `week` / `weeks`，不使用 period(s)。

## 数据库脚本

`07_*.sql` 至 `23_*.sql` 是已上线的增量记录，涵盖客户、货物管理、状态流程、
Melbourne 价格、仓库预约、吊车和计费修正。它们保留用于审计或重建其他数据库，
不是当前生产环境的启动步骤。

`24_*.sql` 至 `27_*.sql` 是本地保留的历史脚本，但 production migration history 未登记这些版本。production 已有 25–27 的主要价格效果，却缺少 24 的 Resume 函数。不要单独补跑这些旧文件；SQL 32 会以当前 schema 为基线安全补齐 Resume，SQL 33–34 会接管新的最低计费与总价契约。

`28_add_total_quantity.sql` 已于 2026-08-15 在生产数据库执行，为货物增加可选的应到总件数字段和“应到不得少于实到”的约束；脚本没有回填、删除或批量修改现有货物，不要重复执行。

`29_add_automatic_shipment_exceptions.sql` 已于 2026-08-16 在生产数据库执行。它增加异常原因与解除原因，限制 Exception 只能在 Shipment Details 中人工变更，并在页面加载/刷新时根据 V1–V4 运价范围和过期 Scheduled On 日期自动判定异常；不要重复执行。

`30_require_matching_postcode_suburb.sql` 已于 2026-08-16 在生产数据库执行。它将本地配送边界中的 207 个 postcode、402 个正式 suburb 对应关系写入私有映射表，并让计价与自动异常判定都要求 State、Postcode、Suburb 在同一配送区域记录中匹配。不要重复执行。

`31_add_message_sent_and_sms_preparation.sql` 已于 2026-08-16 在生产数据库执行。它增加 Message Sent 状态与事件类型，并提供原子 RPC，在系统准备短信时记录 `sms_prepared_at`、`sms_prepared_by` 和状态事件；没有修改现有货物数据。不要重复执行。

`32_unify_status_resume_and_exception_fingerprints.sql` 已于 2026-08-25 在 production 执行。它先验证 SQL31 的表、`shipments.cancelled_at` 与关键 RPC，再补齐专用 Completed Resume、允许普通 Message Sent 状态、统一普通状态 RPC，并为每个自动异常条件分别保存活动/已解决指纹。条件消失时 acknowledgement 会被清除，因此同一条件真正消失后再次出现仍可重新触发。指纹使用 PostgreSQL 内建 `pg_catalog.md5(text)`，不依赖 pgcrypto。

`33_customer_billing_profiles_and_import_batches.sql` 已于 2026-08-25 在 production 执行。它把 Winmav Tail Lift $80、Oreo $70 及 Fuel 20%、GST 10%、Storage $20/m³/week、Warehouse Booking $150、Minimum Volume 1 等 customer-specific 默认值迁入 `customer_billing_profiles`。客户名称只用于一次性 profile seed；运行时不按名称分支。地址计价函数只写 `unit_price` / `delivery_rate_id`，不会覆盖 profile 或人工 override。Excel/CSV 通过单一 transaction RPC 创建稳定 `import_batches`，任一 shipment 失败不会留下 partial batch。历史手工 shipment 的 batch 可以为空。

`34_shipment_storage_and_container_charges.sql` 已于 2026-08-25 在 production 执行。它先把旧 generated `total_charge` 保存到 `legacy_total_charge_snapshot`，再改为数据库触发器维护；部署时只重算非 Completed/Cancelled rows，绝不静默改写历史完成单金额。它持久化 direct Pending Warehouse Booking → DTW 的 $150/$200/custom 模式、让独立 Unbilled Storage 始终参与当前总额，按 `Volume × $20/m³/week` 创建 Storage week，并建立 Melbourne 23:55 job、supplementary Crane Truck Service、原子 Shipment Details RPC 及每 batch/container 唯一的 Container Service Fee。SQL34 当时的 Warehouse GST 解释已由 SQL36 正式取代。

`35_draft_bills_and_atomic_finalise.sql` 已于 2026-08-25 在 production 执行。它创建唯一 Draft Billing Editor、Expected/Actual components、税前/GST/含税金额、Add/Remove/Save/Finalise/Discard RPC。Draft Save 只修改 Billing Item Actual 并按 Shipment 合并写入 `billing_updated` Activity，不修改 Shipment Expected 或任何 Operations 字段；Finalise 在一个 transaction 中只更新收费来源的 billing 字段。Finalised Billing Items 有数据库不可变保护，Billed 页面从 finalised Actual snapshot 读取，不再用实时 Shipment 公式重算历史。

`36_pickup_profiles_and_storage_schedule_revisions.sql` 已于 2026-08-26 在 production 执行。它加入 Customer/Shipment Pickup rate snapshot、Admin Billing Profile RPC、Warehouse Booking ex-GST 口径、Crane `$850` fallback、Storage Start Date/Episode GST snapshot、即时 backfill、schedule revision audit、Billed Week Credits、Storage Credit Required、Details Activity 与最小权限 grants。部署时只修复当前 On Hold 且缺失 Episode 的明确 SQL34 缺口；该测试票从 Profile 取得 `$20/m³/week` 并生成 4 个当前 Unbilled weeks。Finalised Billing Items 与 Billed Storage 历史没有被改写。

SQL 32–36 已执行且不得修改或重跑。Warehouse Booking `$150/$200/custom` 从 SQL36 起都是 ex GST，只加一次 GST；Container Service Fee 金额保持为空，直到业务确认并由管理员配置。

2026-08-26 已运行只读 `PREDEPLOY_SCHEMA_CHECK_SQL36.sql` 并通过。由于当前 Supabase 套餐不支持 Branching，用户确认 production 数据均为测试数据后，`STAGING_SMOKE_SQL36.sql` 在 production 单一 transaction 内完整运行并最终 `ROLLBACK`；Pickup、Warehouse、Storage revision/credits、Activity、权限、Finalise immutability 与 Import rollback 全部通过，原有 Draft 保持 1 张/4 项。

任何新数据库改动都必须先核对线上 schema、函数、触发器和 RLS，再使用新的顺序编号；
不得覆盖或重跑 07–23。

## 主要文件

- `index.html` / `app.js`：运营系统界面与 Supabase 数据操作。
- `billing-logic.js`：浏览器与 Node 测试共用的无依赖计费公式。
- `map.html` / `google-app.js`：配送地图与批量地址搜索。
- `data/delivery-areas.geojson`：当前地图使用的邮编和 suburb 边界。
- `google-sheets-delivery-automation.gs`：Google Sheets 行移动与恢复自动化。
- `README.txt`：原地图生成与布局说明，保留供边界维护参考。
- `CODEX_HANDOFF_2026-08-14.md`：2026-08-14 的历史交接快照。

## 最小验证

```powershell
node --check app.js
node --check google-app.js
node --check billing-logic.js
node status-workflow.test.mjs
node pricing-rates.test.mjs
node billing-workflow.test.mjs
node sql36-workflow.test.mjs
```

Node 测试包含纯函数行为测试和源码契约检查；SQL36 的数据库行为另由 transaction + rollback smoke 验证。浏览器交互仍需在前端部署前由 Admin 测试账号人工核对。

## 暂缓业务定义

本轮未实现 Invoice PDF/Excel、invoice number、Paid/Unpaid/Overdue、付款核销、自动邮件、会计软件集成、自动 weekly queue、supplementary invoice workflow、多 Draft、Storage Credit Note/退款或未确认的 Container Service Fee 金额。
