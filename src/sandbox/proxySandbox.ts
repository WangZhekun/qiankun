/* eslint-disable no-param-reassign */
/**
 * @author Kuitos
 * @since 2020-3-31
 */
import type { SandBox } from '../interfaces';
import { SandBoxType } from '../interfaces';
import { nextTask } from '../utils';
import { getTargetValue, setCurrentRunningApp } from './common';

/**
 * fastest(at most time) unique array method
 * @see https://jsperf.com/array-filter-unique/30
 */
function uniq(array: Array<string | symbol>) {
  return array.filter(function filter(this: PropertyKey[], element) {
    return element in this ? false : ((this as any)[element] = true);
  }, Object.create(null));
}

// zone.js will overwrite Object.defineProperty
const rawObjectDefineProperty = Object.defineProperty;

const variableWhiteListInDev =
  process.env.NODE_ENV === 'development' || window.__QIANKUN_DEVELOPMENT__
    ? [
        // for react hot reload
        // see https://github.com/facebook/create-react-app/blob/66bf7dfc43350249e2f09d138a20840dae8a0a4a/packages/react-error-overlay/src/index.js#L180
        '__REACT_ERROR_OVERLAY_GLOBAL_HOOK__',
      ]
    : [];
// who could escape the sandbox
// 跳过沙箱，直接操作主应用全局对象的属性白名单
const variableWhiteList: PropertyKey[] = [
  // FIXME System.js used a indirect call with eval, which would make it scope escape to global
  // To make System.js works well, we write it back to global window temporary
  // see https://github.com/systemjs/systemjs/blob/457f5b7e8af6bd120a279540477552a07d5de086/src/evaluate.js#L106
  'System',

  // see https://github.com/systemjs/systemjs/blob/457f5b7e8af6bd120a279540477552a07d5de086/src/instantiate.js#L357
  '__cjsWrapper',
  ...variableWhiteListInDev,
];

/*
 variables who are impossible to be overwrite need to be escaped from proxy sandbox for performance reasons
 */
const unscopables = {
  undefined: true,
  Array: true,
  Object: true,
  String: true,
  Boolean: true,
  Math: true,
  Number: true,
  Symbol: true,
  parseFloat: true,
  Float32Array: true,
};

type SymbolTarget = 'target' | 'rawWindow';

type FakeWindow = Window & Record<PropertyKey, any>;

function createFakeWindow(global: Window) {
  // map always has the fastest performance in has check scenario
  // see https://jsperf.com/array-indexof-vs-set-has/23
  const propertiesWithGetter = new Map<PropertyKey, boolean>(); // 全局对象中有getter访问器的不可配置属性
  const fakeWindow = {} as FakeWindow;

  /*
   copy the non-configurable property of global to fakeWindow
   see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/getOwnPropertyDescriptor
   > A property cannot be reported as non-configurable, if it does not exists as an own property of the target object or if it exists as a configurable own property of the target object.
   */
  Object.getOwnPropertyNames(global) // 取全局对象的自有属性
    .filter((p) => {
      const descriptor = Object.getOwnPropertyDescriptor(global, p); // 取属性p的描述对象
      return !descriptor?.configurable; // 过滤没有描述对象或不可修改配置的属性
    }) // 此处为何要过滤，而非覆盖global的全部属性？当其他属性被修改时，才在伪全局对象中创建
    .forEach((p) => {
      const descriptor = Object.getOwnPropertyDescriptor(global, p); // 取属性p的描述对象
      if (descriptor) {
        const hasGetter = Object.prototype.hasOwnProperty.call(descriptor, 'get'); // 属性p有getter访问器

        /*
         make top/self/window property configurable and writable, otherwise it will cause TypeError while get trap return.
         see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/get
         > The value reported for a property must be the same as the value of the corresponding target object property if the target object property is a non-writable, non-configurable data property.
         */
        if (
          p === 'top' ||
          p === 'parent' ||
          p === 'self' ||
          p === 'window' ||
          (process.env.NODE_ENV === 'test' && (p === 'mockTop' || p === 'mockSafariTop'))
        ) {
          // 属性p是top parent self window mockTop mockSafariTop属性
          descriptor.configurable = true; // 属性p可配置
          /*
           The descriptor of window.window/window.top/window.self in Safari/FF are accessor descriptors, we need to avoid adding a data descriptor while it was
           Example:
            Safari/FF: Object.getOwnPropertyDescriptor(window, 'top') -> {get: function, set: undefined, enumerable: true, configurable: false}
            Chrome: Object.getOwnPropertyDescriptor(window, 'top') -> {value: Window, writable: false, enumerable: true, configurable: false}
           */
          if (!hasGetter) {
            // 没有getter访问器
            descriptor.writable = true; // 属性p可修改
          }
        }

        if (hasGetter) propertiesWithGetter.set(p, true);

        // freeze the descriptor to avoid being modified by zone.js
        // see https://github.com/angular/zone.js/blob/a5fe09b0fac27ac5df1fa746042f96f05ccb6a00/lib/browser/define-property.ts#L71
        rawObjectDefineProperty(fakeWindow, p, Object.freeze(descriptor)); // 给fakeWindow添加属性p
      }
    });

  return {
    fakeWindow,
    propertiesWithGetter,
  };
}

let activeSandboxCount = 0; // 启动的沙箱实例计数器

/**
 * 基于 Proxy 实现的沙箱
 * 修改全局对象时，会把修改后的值放到伪全局对象中，在沙箱对象注销时，伪全局对象也会失效
 */
export default class ProxySandbox implements SandBox {
  /** window 值变更记录 */
  private updatedValueSet = new Set<PropertyKey>();

  name: string; // 子应用名称

  type: SandBoxType; // 沙箱类型

  proxy: WindowProxy; // 全局对象的代理对象

  globalContext: typeof window;

  sandboxRunning = true; // 沙箱启动标志

  latestSetProp: PropertyKey | null = null; // 最后一次修改的全局对象中的属性

  private registerRunningApp(name: string, proxy: Window) {
    if (this.sandboxRunning) {
      setCurrentRunningApp({ name, window: proxy });
      // FIXME if you have any other good ideas
      // remove the mark in next tick, thus we can identify whether it in micro app or not
      // this approach is just a workaround, it could not cover all complex cases, such as the micro app runs in the same task context with master in some case
      nextTask(() => {
        setCurrentRunningApp(null);
      });
    }
  }

  active() {
    if (!this.sandboxRunning) activeSandboxCount++; // 计数器加一
    this.sandboxRunning = true; // 置沙箱启动标志
  }

  inactive() {
    if (process.env.NODE_ENV === 'development') {
      console.info(`[qiankun:sandbox] ${this.name} modified global properties restore...`, [
        ...this.updatedValueSet.keys(),
      ]);
    }

    if (--activeSandboxCount === 0) {
      // 计数器是否归零
      variableWhiteList.forEach((p) => {
        if (this.proxy.hasOwnProperty(p)) {
          // @ts-ignore
          delete this.globalContext[p];
        }
      });
    }

    this.sandboxRunning = false;
  }

  constructor(name: string, globalContext = window) {
    this.name = name;
    this.globalContext = globalContext;
    this.type = SandBoxType.Proxy;
    const { updatedValueSet } = this;

    const rawWindow = globalContext; // 主应用的全局对象
    const { 
      fakeWindow, // 伪全局对象
      propertiesWithGetter // 全局对象中有getter访问器的不可配置属性
    } = createFakeWindow(rawWindow); // 创建伪全局对象

    const descriptorTargetMap = new Map<PropertyKey, SymbolTarget>();
    const hasOwnProperty = (key: PropertyKey) => fakeWindow.hasOwnProperty(key) || rawWindow.hasOwnProperty(key); // 伪全局对象或原始全局对象有属性key

    // 创建代理对象
    const proxy = new Proxy(fakeWindow, {
      set: (target: FakeWindow, p: PropertyKey, value: any): boolean => {
        if (this.sandboxRunning) { // 当前沙箱已启动
          this.registerRunningApp(name, proxy);
          // We must kept its description while the property existed in rawWindow before
          if (!target.hasOwnProperty(p) && rawWindow.hasOwnProperty(p)) {
            // p属性，不在伪对象中，在原始全局对象中
            const descriptor = Object.getOwnPropertyDescriptor(rawWindow, p); // 取属性p的描述对象
            const { writable, configurable, enumerable } = descriptor!;
            if (writable) {
              // 可修改
              Object.defineProperty(target, p, {
                // 在伪全局对象中添加属性p
                configurable,
                enumerable,
                writable,
                value,
              });
            }
          } else {
            // p属性为新属性，或已在伪全局对象中存在
            // @ts-ignore
            target[p] = value; // 更新伪全局对象中的属性p的值
          }

          if (variableWhiteList.indexOf(p) !== -1) {
            // 跳过代理的白名单属性
            // @ts-ignore
            rawWindow[p] = value; // 更新原始全局对象中属性p的值
          }

          updatedValueSet.add(p); // 记录属性p发生变更

          this.latestSetProp = p; // 更新最后一次修改的全局对象的属性

          return true;
        }

        if (process.env.NODE_ENV === 'development') {
          console.warn(`[qiankun] Set window.${p.toString()} while sandbox destroyed or inactive in ${name}!`);
        }

        // 在 strict-mode 下，Proxy 的 handler.set 返回 false 会抛出 TypeError，在沙箱卸载的情况下应该忽略错误
        return true;
      },

      get: (target: FakeWindow, p: PropertyKey): any => {
        this.registerRunningApp(name, proxy);

        if (p === Symbol.unscopables) return unscopables;
        // avoid who using window.window or window.self to escape the sandbox environment to touch the really window
        // see https://github.com/eligrey/FileSaver.js/blob/master/src/FileSaver.js#L13
        if (p === 'window' || p === 'self') {
          // 将获取全局对象的属性指向代理对象本身
          return proxy;
        }

        // hijack globalWindow accessing with globalThis keyword
        if (p === 'globalThis') {
          // 将获取全局对象的属性指向代理对象本身
          return proxy;
        }

        if (
          p === 'top' ||
          p === 'parent' ||
          (process.env.NODE_ENV === 'test' && (p === 'mockTop' || p === 'mockSafariTop'))
        ) {
          // if your master app in an iframe context, allow these props escape the sandbox
          if (rawWindow === rawWindow.parent) {
            // 将获取全局对象的属性指向代理对象本身
            return proxy;
          }
          return (rawWindow as any)[p];
        }

        // proxy.hasOwnProperty would invoke getter firstly, then its value represented as rawWindow.hasOwnProperty
        if (p === 'hasOwnProperty') {
          // hasOwnProperty方法特殊处理
          return hasOwnProperty;
        }

        // mark the symbol to document while accessing as document.createElement could know is invoked by which sandbox for dynamic append patcher
        if (p === 'document' || p === 'eval') {
          switch (p) {
            case 'document':
              return document;
            case 'eval':
              // eslint-disable-next-line no-eval
              return eval;
            // no default
          }
        }

        // eslint-disable-next-line no-nested-ternary
        const value = propertiesWithGetter.has(p)
          ? (rawWindow as any)[p]
          : p in target
          ? (target as any)[p]
          : (rawWindow as any)[p]; // 取属性p的值
        return getTargetValue(rawWindow, value); // value为函数的情况，绑定rawWindow为this TODO为什么要绑定this到原始全局对象
      },

      // trap in operator
      // see https://github.com/styled-components/styled-components/blob/master/packages/styled-components/src/constants.js#L12
      has(target: FakeWindow, p: string | number | symbol): boolean {
        return p in unscopables || p in target || p in rawWindow;
      },

      getOwnPropertyDescriptor(target: FakeWindow, p: string | number | symbol): PropertyDescriptor | undefined {
        /*
         as the descriptor of top/self/window/mockTop in raw window are configurable but not in proxy target, we need to get it from target to avoid TypeError
         see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/getOwnPropertyDescriptor
         > A property cannot be reported as non-configurable, if it does not exists as an own property of the target object or if it exists as a configurable own property of the target object.
         */
        if (target.hasOwnProperty(p)) {
          const descriptor = Object.getOwnPropertyDescriptor(target, p);
          descriptorTargetMap.set(p, 'target');
          return descriptor;
        }

        if (rawWindow.hasOwnProperty(p)) {
          const descriptor = Object.getOwnPropertyDescriptor(rawWindow, p);
          descriptorTargetMap.set(p, 'rawWindow');
          // A property cannot be reported as non-configurable, if it does not exists as an own property of the target object
          if (descriptor && !descriptor.configurable) {
            descriptor.configurable = true;
          }
          return descriptor;
        }

        return undefined;
      },

      // trap to support iterator with sandbox
      ownKeys(target: FakeWindow): ArrayLike<string | symbol> {
        return uniq(Reflect.ownKeys(rawWindow).concat(Reflect.ownKeys(target)));
      },

      defineProperty(target: Window, p: PropertyKey, attributes: PropertyDescriptor): boolean {
        const from = descriptorTargetMap.get(p);
        /*
         Descriptor must be defined to native window while it comes from native window via Object.getOwnPropertyDescriptor(window, p),
         otherwise it would cause a TypeError with illegal invocation.
         */
        switch (from) {
          case 'rawWindow':
            return Reflect.defineProperty(rawWindow, p, attributes);
          default:
            return Reflect.defineProperty(target, p, attributes);
        }
      },

      deleteProperty: (target: FakeWindow, p: string | number | symbol): boolean => {
        this.registerRunningApp(name, proxy);
        if (target.hasOwnProperty(p)) {
          // @ts-ignore
          delete target[p];
          updatedValueSet.delete(p);

          return true;
        }

        return true;
      },

      // makes sure `window instanceof Window` returns truthy in micro app
      getPrototypeOf() {
        return Reflect.getPrototypeOf(rawWindow);
      },
    });

    this.proxy = proxy;

    activeSandboxCount++;
  }
}
