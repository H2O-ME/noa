/**
 * 网关的 socket 工厂：默认用运行时的全局 `WebSocket` 连出去。
 *
 * 从 `runtime.ts` 拆出，因为它是另一个问题：那边讲**通道怎么装配起来**（凭据、
 * 网关、插件、启停生命周期），这里讲**拨号那一下用什么 socket**（生产走真
 * WebSocket，测试注入假的）。前者是装配，后者是传输细节。
 */
import type { SocketFactory } from './gateway.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, QqTimeoutError } from './deadline.js';

/**
 * How long the TCP/TLS handshake and WebSocket upgrade may take.
 *
 * A socket that never opens and never errors is the worst failure this package
 * can have: nothing retries, nothing reports, and the operator is left looking at
 * "connecting" forever. The bound turns it into an ordinary dial failure the
 * reconnect path already knows how to handle.
 */
export const SOCKET_OPEN_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MS;

/**
 * The default transport: connect a real `WebSocket` and resolve on open.
 * @param url - the gateway URL from `resolveGatewayUrl`.
 * @returns the socket handle the gateway drives.
 * @throws QqTimeoutError when the handshake exceeds `SOCKET_OPEN_TIMEOUT_MS`.
 */
export const defaultSocketFactory: SocketFactory = async (url) => {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Give the half-open socket back rather than leaking it: a WebSocket that
      // never fired `open` is still holding a connection.
      try {
        ws.close();
      } catch {
        // A close on an already-failed socket throws in some runtimes; the
        // timeout is the outcome either way.
      }
      reject(new QqTimeoutError('websocket open', SOCKET_OPEN_TIMEOUT_MS));
    }, SOCKET_OPEN_TIMEOUT_MS);
    const settle = (fn: () => void): void => {
      clearTimeout(timer);
      fn();
    };
    ws.addEventListener('open', () => { settle(resolve); }, { once: true });
    ws.addEventListener('error', () => { settle(() => reject(new Error('websocket open failed'))); }, { once: true });
  });
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onMessage: (cb) => ws.addEventListener('message', (ev) => cb(String((ev as MessageEvent).data))),
    onClose: (cb) => ws.addEventListener('close', () => cb(false)),
  };
};
