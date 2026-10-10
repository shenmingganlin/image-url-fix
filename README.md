# 如实生图

Hana v2 应用。需要 Hana `1.0.11-beta` 或更高版本。

Hana 1.0.11 已经修好中转站只返回图片网址时收不回图的问题。官方适配器会把普通网址下载回来。这个应用不再接管 `openai-images`，也不再自己下载。

重心转到交图之后的体验。官方流程收下图之后，本应用只核对 `gpt-image-2` 的实际边长是否符合请求的比例和分辨率。对上不提示。对不上时，在对应会话的输入框留一句差异；没有可用会话时使用桌面通知。只核对 `gpt-image-2`，其它模型和视频不处理。比例或分辨率缺失、为 `auto`，或读不出边长时，不假装核对成功。

## 这一版还做不到

1.0.11 里，应用订阅到的事件总线，和生图完成时发出 `media-gen:task-done` 的总线，不是同一个对象。订阅可以挂上，完成事件到不了回调。所以这一版不会在输入框留下那一句，也不会弹出尺寸提醒。

装上这一版的实际效果是：不再接管协议，官方继续收图。边长提醒要等宿主把完成事件送到应用能订阅的那条总线上，才会出现。

## 它不再做的事

- 不接管 `openai-images`
- 不下载图片，也不还原网址里的 `%2F`
- 不改请求里的比例、分辨率、画质和格式

[#2499](https://github.com/liliMozi/openhanako/issues/2499) 那种「中转只给网址、内置适配器收不回图」，由 Hana 1.0.11 的官方流程负责。本应用不再为这件事替换适配器。[#956](https://github.com/liliMozi/openhanako/issues/956) 里「支持 url 响应」这一半也一样。火山等其它协议不在这里。

## 开源

代码以 MIT 许可公开。仓库在 [shenmingganlin/image-url-fix](https://github.com/shenmingganlin/image-url-fix)，安装包在 [Releases](https://github.com/shenmingganlin/image-url-fix/releases)。
