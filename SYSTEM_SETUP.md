# BentWay 物流运营系统：本地启动说明

## 当前数据库状态

Supabase 项目和生产数据库已经创建并投入使用。2026-08-21 的只读核对显示 migration history 登记为 10–23、28–31；24–27 的部分效果已存在，但 production 缺少 `resume_completed_shipment()`。因此不要依据旧 README 重跑 07–31。

这些 SQL 文件是增量历史记录。不要为日常启动重新执行，也不要重建数据库。
如需数据库变更，应先检查线上结构和现有函数，再从下一个编号建立新的增量脚本。

`24_*.sql` 至 `27_*.sql` 的 production migration history 未登记，但 production 已存在 25–27 的主要价格效果。不要为“补编号”而重跑这些旧文件；缺失的 Resume 已由 SQL 32 补齐，新的最低计费与总价由 SQL 33–34 接管。

`28_add_total_quantity.sql` 已于 2026-08-15 在生产数据库执行。该脚本只增加可空字段及校验约束，没有回填、删除或批量修改现有货物；不要重复执行。

`29_add_automatic_shipment_exceptions.sql` 已于 2026-08-16 在生产数据库执行。它保存 Exception 与解除 Exception 的原因、阻止 B 页普通状态操作跳过原因校验，并在系统加载货物时按现有 V1–V4 运价匹配和 Melbourne 过期 Scheduled On 日期自动写入 Exception 及事件记录。该脚本没有删除、回填或重置现有货物；不要重复执行。

`30_require_matching_postcode_suburb.sql` 已于 2026-08-16 在生产数据库执行。它使用 `data/delivery-areas.geojson` 中与生产运价表完全对应的 207 个 postcode 和 402 个正式 suburb 建立私有映射，并统一收紧计价触发器与异常判定函数，要求 State、Postcode、Suburb 相互对应。不要重复执行。

`31_add_message_sent_and_sms_preparation.sql` 已于 2026-08-16 在生产数据库执行。它增加 Message Sent 状态和事件类型，并通过 `mark_shipment_sms_prepared` RPC 原子记录短信准备时间、操作人及状态事件；没有修改、删除或回填现有货物。不要重复执行。

## 已部署 migration（2026-08-25 至 2026-08-26）

以下 migration 已按顺序执行并登记，禁止重跑：

1. `32_unify_status_resume_and_exception_fingerprints.sql`
2. `33_customer_billing_profiles_and_import_batches.sql`
3. `34_shipment_storage_and_container_charges.sql`
4. `35_draft_bills_and_atomic_finalise.sql`
5. `36_pickup_profiles_and_storage_schedule_revisions.sql`

SQL 34 已启用 `pg_cron`、建立每 5 分钟运行的 `bentway-storage-periods` job；SQL36 保留该 job 并让函数只生成下一笔到期 week。不要另建浏览器 timer。SQL32–36 禁止重跑，后续数据库变更必须从 SQL 37 开始。

SQL36 部署前已运行只读 `PREDEPLOY_SCHEMA_CHECK_SQL36.sql`。Supabase Branching 因套餐不支持而未创建；用户确认当前 production 全为测试数据后，完整 `STAGING_SMOKE_SQL36.sql` 在单一 transaction 内运行并 `ROLLBACK`，原有 Draft 与测试基线均保留。

执行 SQL 33 后，核对测试 customer 的 `customer_billing_profiles.default_storage_rate`。当前通用默认是 AUD $20/m³/week；Shipment 进入 On Hold 时还必须有有效 Volume，第一周期金额为 `Volume × Rate`。Container Service Fee 的 `amount` 仍保持空值，业务确认后再配置。

## 启动系统

1. 双击 `START-BENTWAY-SYSTEM.cmd`。
2. 保持弹出的服务器窗口开启。
3. 浏览器会自动打开 `http://localhost:8080/`。
4. 使用 Supabase `Authentication → Users` 中已有的员工邮箱和密码登录。

如果端口已被占用，启动脚本会提示；已有页面仍可刷新后继续使用。

## Supabase 网页配置

当前 `supabase-config.js` 已配置浏览器可用的项目 URL 与 publishable key。只有在
文件仍显示占位符或项目被正式迁移时才需要修改。

网页文件中只允许出现 publishable key。不要写入：

- `sb_secret_...`
- `service_role`
- 数据库密码
- `postgresql://...` 连接字符串

## 安全冒烟测试

1. 使用测试货物，不要直接操作真实货物。
2. 确认 Pending Shipments、Shipment Intake、Shipment History 和 Delivery Map 可打开。
3. 测试 OV/BV 切换、Details 左右双栏独立滚动、详情原子保存和地图定位。
4. 分别核对普通计费、direct Pending Warehouse Booking → DTW 的 $150、$200、自定义价格，以及 Warehouse Booking 加上独立 Unbilled Storage 后的总额。SQL36 起 booking core 和 Storage 都是 ex GST，各自使用适用 GST snapshot 且只加税一次。
5. 仅使用测试记录测试 Delivered、Picked Up 或软删除；软删除后界面隐藏，数据库记录保留。
6. 用测试 completed shipment 验证 Details 与 History 批量 Resume 都回到 Pending，并清除 outbound/scheduled/on-hold 字段；检查事件历史仍存在。
7. 用 Volume = 4m³、Storage rate = $20 的测试 shipment 进入 On Hold，确认当天产生 `$80 ex GST` 的第一周；Backdated Storage Start Date 必须立即补齐所有到期完整周，离开后当前周保留且 Episode 结束。
8. 创建 Draft 后确认来源项目仍未 Billed；测试 Add/Remove、连续 Storage week 合并与 Qty、Fuel Rate/Manual、Delivery Actual component 修改和 Activity。确认 Draft Save 不改变 Shipment Expected、Crane Operations、Storage source、Container source；Discard 后来源仍可选择。
9. Finalise 前核对税前、GST、含税汇总无二次 GST；Finalise 后确认只改变 billing 字段，Shipment 仍留在原 Pending/History/Status 生命周期。
10. 对已开 Delivery 的测试 Shipment 从 Crane Negative 改为 Positive，确认产生独立 `Crane Truck Service`；对未开 Delivery 的 Shipment 确认 Crane 仍属于 Delivery Total。
11. Billing Status = Billed 时核对 finalised Actual 历史金额，不应显示实时 Shipment 重算值；之后修改 Shipment 当前计费，旧 Bill 必须保持不变。

12. 用 610kg Shipment 完成 Picked Up，确认 Pickup Service 为 `$122 ex GST / $12.20 GST / $134.20 incl GST`，且不显示 Volume Delivery、Tail Lift、Fuel 或 Crane。
13. Admin 打开 Billing Profiles，核对 Winmav/Oreo Pickup `$0.20/kg ex GST`、Warehouse `$150 ex GST`、Storage `$20/m³/week` 和 Last Updated/By；非 Admin 不应看到入口或调用保存 RPC。
14. 修改已 On Hold 的 Storage Start Date，先核对 server preview；有 Billed weeks 时确认 earliest-first Covered，超出 Due 的 credits 只显示 Storage Credit Required，不自动退款。

SQL 32–36 已部署；步骤 6–14 仍应只使用明确的测试 Shipment，不要对真实业务记录做破坏性验证。

## 客户与货物管理

客户记录在 Supabase `customers` 表中维护；`name` 为客户名称，`customer_code` 为
可选简称或编号。管理员可将货物从系统界面移除，但数据库货物记录及事件历史会保留。

完整项目结构、已完成功能和部署说明见 `README.md`。
