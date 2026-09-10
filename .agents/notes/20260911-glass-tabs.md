# 横向标签间距回归

生产截图顶部对话/轨迹/上下文挤在一起。官方标签原gap36px且按钮水平padding0，自有通用toolbar/tablist规则改成gap6px却未补按钮内边距。改用独立横向tablist规则：fit-content、4px容器padding/gap、按钮水平14px，aria-selected背景选中态和透明下划线。保留原处理器和aria关联，排除vertical布局。新增浏览器宽度/间距/选中态/窄屏滚动/竖向不覆盖断言，零官方文件修改。
