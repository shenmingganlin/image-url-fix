# 如实生图

Hana 的 v2 应用，给中转站上的 OpenAI 图片模型用。不用改 Hana。

很多中转不按官方把图放在 `b64_json` 里，只给一个网址。Hana 内置适配器会在这里崩溃，中转站那边图已经生成、费用也扣了。装上这个应用后，由它接管 `openai-images`。

供应商和模型要先在 Hana 里配好，协议用 openai-images。这个应用不新建供应商，也不把模型加进目录。

## 它做什么

中转只返回网址时，应用把图下载回来。网址里的斜杠被写成 `%2F` 时，先还原再下。下载不走 Hana 的代理，所以需要允许启动子进程。返回 `b64_json` 时直接收下。

你在生图设置里选的比例、分辨率、画质和格式会写进请求。助手当场点名的，以助手为准，不会被设置盖掉。每次请求一张。

边长和格式都会核对。对上了，只把图交进对话。对不上时图仍然交出，裁切过或换过格式的也能用；同一场对话的输入框上会留下一条差异，写明送出的是什么、交回的是什么。你可以关掉它。下一次这场对话对上时，这条会自己撤掉，那张对的图会晚几秒出现。中转如果改了像素，应用改不了中转，只会把差异说出来。

接口没给图片、下载失败，这次才是失败，聊天里会写「图片生成失败」，不交空图。

对话对不上地址时，差异改走桌面通知。通知没允许，这句话只写进应用日志，图仍会交出。

不管这些：先返回任务号、再轮询的异步中转；火山、通义、ComfyUI 这类别的协议。

## 能对上的议题

仓库在 [shenmingganlin/image-url-fix](https://github.com/shenmingganlin/image-url-fix)，安装包在 [Releases](https://github.com/shenmingganlin/image-url-fix/releases) 的 `app-image-url-fix-0.5.0.zip`。

- [#2499](https://github.com/liliMozi/openhanako/issues/2499) 中转返回网址，内置适配器 `Buffer.from(undefined)` 崩溃。这个应用下载网址，也认 base64，不用改 Hana 本体。
- [#956](https://github.com/liliMozi/openhanako/issues/956) 里「支持 url 响应」这一半。只覆盖 OpenAI 图片协议。不改火山适配器，也没有做全局禁用内置插件的开关；装上之后，openai-images 由这个应用接管。

下面这些看起来像，但这个应用解决不了，不要回复成已经修好：

- [#1684](https://github.com/liliMozi/openhanako/issues/1684) 异步任务。中转先给任务号、再轮询 `/v1/tasks` 的，接不上。
- [#511](https://github.com/liliMozi/openhanako/issues/511)、[#543](https://github.com/liliMozi/openhanako/issues/543)、[#633](https://github.com/liliMozi/openhanako/issues/633)、[#2191](https://github.com/liliMozi/openhanako/issues/2191)、[#1480](https://github.com/liliMozi/openhanako/issues/1480)、[#1408](https://github.com/liliMozi/openhanako/issues/1408)、[#2220](https://github.com/liliMozi/openhanako/issues/2220) 自定义供应商，或把 gpt-image-2 加进模型列表。模型得先在 Hana 里配好。
- [#1413](https://github.com/liliMozi/openhanako/issues/1413) 生图工具只允许一张参考图。那是 Hana 工具自己的限制。
- [#660](https://github.com/liliMozi/openhanako/issues/660) 火山引擎不接受 `output_format`。不是这条协议。

## 启用前

需要提供媒体适配器、读取供应商密钥、启动子进程。启动子进程要等应用下次启动才生效。显示通知只是对话对不上时的后备。

## 停用后

Hana 原来的生图适配器要等 Hana 重新启动才回来。

应用开着的时候，不要手改这些图片模型的目录。新加的模型要等应用重新加载后，参数才会出现在设置里。

## 开源

代码以 MIT 许可公开。
