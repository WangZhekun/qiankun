/**
 * @author Kuitos
 * @since 2020-02-21
 */

/**
 * TODO
 */
export { addErrorHandler, removeErrorHandler } from 'single-spa';

/**
 * TODO
 * @param errorHandler
 */
export function addGlobalUncaughtErrorHandler(errorHandler: OnErrorEventHandlerNonNull): void {
  window.addEventListener('error', errorHandler);
  window.addEventListener('unhandledrejection', errorHandler);
}

/**
 * TODO
 * @param errorHandler
 */
export function removeGlobalUncaughtErrorHandler(errorHandler: (...args: any[]) => any) {
  window.removeEventListener('error', errorHandler);
  window.removeEventListener('unhandledrejection', errorHandler);
}
