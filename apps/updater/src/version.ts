/** updater 自身版本与协议版本（镜像内固定的编译期常量，整个 U1 计划期间保持 0.1.0）。 */
export const UPDATER_VERSION = "0.1.0";

/** 本执行器实现的 updater 协议版本；清单里的 requiredUpdaterProtocol 高于它即拒绝更新。 */
export const UPDATER_PROTOCOL_VERSION = 1;
