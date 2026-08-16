# BentWay 物流运营系统：本地启动说明

## 当前数据库状态

Supabase 项目和生产数据库已经创建并投入使用，`07_create_customers.sql` 至
`23_soft_delete_shipments.sql` 均已执行。

这些 SQL 文件是增量历史记录。不要为日常启动重新执行，也不要重建数据库。
如需数据库变更，应先检查线上结构和现有函数，再从下一个编号建立新的增量脚本。

Shipment History 的 Resume 功能需要新增的 `24_resume_completed_shipments.sql`。部署前核对并仅执行一次，不要重复执行 07–23。

V2 postcode 3004 的价格需要新增的 `25_add_v2_postcode_3004.sql`。核对后仅执行一次；该脚本不会重建数据库，只会新增或校正该邮编价格并刷新对应的未完成货物。

最低计费体积规则需要新增的 `26_minimum_billable_volume.sql`。核对后仅执行一次；Volume 小于 1 m³ 时 Total Charge 按 1 m³ 计算，原始 Volume 不会被改写。

如果列表仍显示旧 Fuel Levy 或 Total Charge，执行一次 `27_sync_minimum_billable_volume.sql`；它会同步两个数据库生成列，无需重跑 07–26。

`28_add_total_quantity.sql` 已于 2026-08-15 在生产数据库执行。该脚本只增加可空字段及校验约束，没有回填、删除或批量修改现有货物；不要重复执行。

`29_add_automatic_shipment_exceptions.sql` 已于 2026-08-16 在生产数据库执行。它保存 Exception 与解除 Exception 的原因、阻止 B 页普通状态操作跳过原因校验，并在系统加载货物时按现有 V1–V4 运价匹配和 Melbourne 过期 Scheduled On 日期自动写入 Exception 及事件记录。该脚本没有删除、回填或重置现有货物；不要重复执行。

`30_require_matching_postcode_suburb.sql` 已于 2026-08-16 在生产数据库执行。它使用 `data/delivery-areas.geojson` 中与生产运价表完全对应的 207 个 postcode 和 402 个正式 suburb 建立私有映射，并统一收紧计价触发器与异常判定函数，要求 State、Postcode、Suburb 相互对应。不要重复执行。

`31_add_message_sent_and_sms_preparation.sql` 已于 2026-08-16 在生产数据库执行。它增加 Message Sent 状态和事件类型，并通过 `mark_shipment_sms_prepared` RPC 原子记录短信准备时间、操作人及状态事件；没有修改、删除或回填现有货物。不要重复执行。

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
3. 测试 A/B 表格切换、详情编辑和地图定位。
4. 分别核对普通计费、Pending Warehouse Booking 的 $150 总额，以及该状态下吊车选项被禁用。
5. 仅使用测试记录测试 Delivered、Picked Up 或软删除；软删除后界面隐藏，数据库记录保留。

## 客户与货物管理

客户记录在 Supabase `customers` 表中维护；`name` 为客户名称，`customer_code` 为
可选简称或编号。管理员可将货物从系统界面移除，但数据库货物记录及事件历史会保留。

完整项目结构、已完成功能和部署说明见 `README.md`。
