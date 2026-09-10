---
name: cdg-bridge
description: 当前会话工作区内的 CDG/Esafenet 文件检查、读取、解密、加密、搜索和受保护编辑。用户提到 CDG、绿盾、亿赛通、Esafenet、加密文件、解密文件或无法读取的受保护文件时使用。
metadata:
  dsh:
    version: "2"
    capabilities:
      filesystem:
        - scope-workspace
---

# CDG Bridge

## 首选工具

直接调用 `cdg_file`，不要先用普通 `read` 失败一次来判断是否加密。
所有路径都相对当前会话工作区；不要请求或传递密钥路径。

常用动作：

- `inspect`：检查文件是否为 CDG，并返回元数据。
- `list`：列出工作区相对条目；用 `path: "."` 发现文件，不猜宿主路径。
- `read`：有界读取明文或加密文件；单次最多 64 KiB，返回 JSON 的 content、nextOffset、eof。二进制用 `encoding: "base64"`；续读按字节 nextOffset。
- `decrypt_file`：解密到另一个工作区路径，默认禁止覆盖；源文件始终保留。
- `write`：从工作区内的明文文件创建 CDG 文件。
- `write_text`：从用户提供的文本创建 CDG 文件。
- `write_plaintext`：写普通文本交付物，文本参数为 text，目标为 output_path；不会加密，不覆盖加密原件。
- `append_text`：追加文本，保留原文件明文或加密状态；最多 8 MiB。patch 不能用于扩长。
- `embed_images`：把 HTML 的本地 img src 图片内嵌到不同 output_path 的 UTF-8 明文副本；保留真实图片，不用插画替代。最多 8 MiB，不打包 CSS/JS、srcset 或远程资源。
- `grep`：搜索单个明文/CDG 文件；目录只搜索 CDG，混合目录用普通 grep/Bash。
- `replace_text`：精确文本替换；默认只预览，实际修改时传 `dry_run: false`。
- `replace`：目录或正则替换；默认只预览并受最大替换数保护。
- `patch`：用 Base64 表示的定长字节做固定偏移修改。
- `encrypt_dir`：加密目录到独立输出目录，默认只预览。
- `decrypt_dir`：解密目录到独立输出目录，默认只预览。
- `doctor`：检查当前 CDG 安装和项目级 MCP 状态；healthy=false 可能仅表示外部客户端未注册，不代表文件工具不可用。

普通 HTML/PDF 交付不使用 write_text，它是显式加密动作，并非工作区默认加密全部文件。
既有加密产物用 decrypt_file 导出明文副本，inspect 确认 isEncrypted=false；HTML 确认 UTF-8，并实际验证内嵌图片显示。

## 安全规则

- 解密必须写入与源文件不同的路径；默认 `no_clobber: true`，不得删除源文件。
- 经授权替换已有单文件输出时，传 `overwrite: true` 或 `no_clobber: false`；两者不得冲突。
- 目录加解密必须先使用默认 dry-run 查看计划；用户明确确认后才能传
  `dry_run: false`。
- 批量替换同样先 dry-run；对单文件修改优先使用 `expected_sha256` 防止覆盖
  并发变化。
- 不得尝试 `../`、其他用户目录、绝对越界路径、符号链接逃逸或密钥文件。
- 大型二进制优先在工作区处理；只在需要字节时分块 read/base64，不把整个大文件塞进对话。浏览器下载不会写入工作区。
- 完成后报告输出的工作区相对路径，并明确原始加密文件仍然保留。
