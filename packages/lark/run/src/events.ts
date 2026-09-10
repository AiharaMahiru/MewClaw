/**
 * 运行生命周期事件（SPEC lark-run.md §4）——声明已迁至
 * dsh-lark-contracts/context（cron 与 run 共享进程事件，避免包循环引用）。
 * 本模块仅保留副作用导入，供既有导入路径继续生效。
 */
import "dsh-lark-contracts/context";
