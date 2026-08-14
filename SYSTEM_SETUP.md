# Bentway物流运营系统：本地启动说明

## 第一次启动前

1. 打开 `supabase-config.js`。
2. 找到：

   ```text
   PASTE_YOUR_COMPLETE_SB_PUBLISHABLE_KEY_HERE
   ```

3. 只用Supabase页面上完整的 `sb_publishable_...` 替换这段文字。
4. 保留两边的英文单引号，不要粘贴 `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=`。
5. 保存文件。

正确格式类似：

```javascript
window.BENTWAY_SUPABASE_CONFIG = Object.freeze({
  url: 'https://fyhqowngijfbeohhefgv.supabase.co',
  publishableKey: 'sb_publishable_这里是完整内容'
});
```

Publishable key是网页公开连接信息。不要在此文件中放入以下任何内容：

- `sb_secret_...`
- `service_role`
- 数据库密码
- `postgresql://...` 连接字符串

## 启动系统

1. 双击 `START-BENTWAY-SYSTEM.cmd`。
2. 保持弹出的黑色小窗口开启。
3. 浏览器会自动打开 `http://localhost:8080/`。
4. 使用在Supabase `Authentication → Users` 中创建的管理员邮箱和密码登录。

## 第一轮测试

登录后应当看到测试货物 `TEST-0001`：

1. 勾选 `TEST-0001`。
2. 点击“在地图查看”，确认地址进入地图并开始定位。
3. 返回待处理清单。
4. 根据测试目的点击 `Delivered` 或 `Picked up`。
5. 确认货物从待处理清单消失，并出现在“已完成记录”。

测试完成前不要对真实货物使用完成按钮。

## 客户资料表

在 Supabase SQL Editor 中运行 `07_create_customers.sql`，保存名称可使用 `07_create_customers`。

这会创建独立的 `customers` 客户资料表、迁移历史货物中已有的客户名称，并让新录入货物通过客户下拉菜单关联到客户资料。

新增客户可以在 Supabase `Table Editor → customers → Insert row` 中完成；`name` 为客户名称，`customer_code` 为可选的客户简称或编号。

## 编辑与删除货物

在 Supabase SQL Editor 中运行 `08_manage_existing_shipments.sql`，保存名称可使用 `08_manage_existing_shipments`。

然后运行 `09_delete_shipments_directly.sql`，保存名称可使用 `09_delete_shipments_directly`。

运行后，管理员可以从待处理货物或历史货物中直接删除记录。删除会同时移除该票货物的事件记录，无法恢复；其他账号不会看到删除按钮。
