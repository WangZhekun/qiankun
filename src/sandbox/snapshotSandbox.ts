/**
 * @author Hydrogen
 * @since 2020-3-8
 */
import type { SandBox } from '../interfaces';
import { SandBoxType } from '../interfaces';

function iter(obj: typeof window, callbackFn: (prop: any) => void) {
  // eslint-disable-next-line guard-for-in, no-restricted-syntax
  for (const prop in obj) {
    // patch for clearInterval for compatible reason, see #1490
    if (obj.hasOwnProperty(prop) || prop === 'clearInterval') {
      callbackFn(prop);
    }
  }
}

/**
 * 基于 diff 方式实现的沙箱，用于不支持 Proxy 的低版本浏览器
 * 在沙箱启动时，创建window快照，恢复子应用对window的修改。沙箱关闭时，记录子应用对window的修改，恢复window快照
 * 问题：在子应用运行时，主应用对window的修改也会被当成子应用的修改被记录
 */
export default class SnapshotSandbox implements SandBox {
  proxy: WindowProxy; // 全局对象

  name: string; // 子应用名称

  type: SandBoxType; // 沙箱类型

  sandboxRunning = true; // 沙箱启动标志

  private windowSnapshot!: Window; // 全局对象快照

  private modifyPropsMap: Record<any, any> = {};

  constructor(name: string) {
    this.name = name;
    this.proxy = window;
    this.type = SandBoxType.Snapshot;
  }

  active() {
    // 记录当前快照
    this.windowSnapshot = {} as Window;
    iter(window, (prop) => {
      // 创建window的快照
      this.windowSnapshot[prop] = window[prop];
    });

    // 恢复之前的变更
    Object.keys(this.modifyPropsMap).forEach((p: any) => {
      window[p] = this.modifyPropsMap[p];
    });

    this.sandboxRunning = true;
  }

  inactive() {
    this.modifyPropsMap = {};

    iter(window, (prop) => {
      if (window[prop] !== this.windowSnapshot[prop]) {
        // 记录变更，恢复环境
        this.modifyPropsMap[prop] = window[prop]; // 记录子应用对window的变更
        window[prop] = this.windowSnapshot[prop]; // 恢复快照
      }
    });

    if (process.env.NODE_ENV === 'development') {
      console.info(`[qiankun:sandbox] ${this.name} origin window restore...`, Object.keys(this.modifyPropsMap));
    }

    this.sandboxRunning = false;
  }
}
