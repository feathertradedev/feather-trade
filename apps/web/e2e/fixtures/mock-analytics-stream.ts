import type { Page } from "@playwright/test";

export async function installMockAnalyticsStream(page: Page) {
  await page.addInitScript(() => {
    type TestWindow = Window & {
      __testEmitCandle: (payload: unknown) => void;
      __testEmitPoolState: (payload: unknown) => void;
      __testEmitPoolStateBatch: (payloads: unknown[]) => void;
      __testHeartbeatPoolStream: () => void;
      __testAdvanceCandleClock: (milliseconds: number) => void;
      __testFailCandleStream: () => void;
      __testFailPoolStream: () => void;
      __testResetCandleStream: () => void;
      __testResetPoolStream: () => void;
    };
    const streams: TestEventSource[] = [];
    class TestEventSource extends EventTarget {
      onerror: ((event: Event) => void) | null = null;
      onopen: ((event: Event) => void) | null = null;
      readyState = 0;
      readonly url: string;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        streams.push(this);
        window.setTimeout(() => {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
        }, 0);
      }

      close() {
        this.readyState = 2;
      }
    }

    Object.defineProperty(window, "EventSource", { configurable: true, value: TestEventSource });
    const testWindow = window as unknown as TestWindow;
    const latest = (path: string) => [...streams].reverse().find((stream) => stream.url.includes(path) && stream.readyState !== 2) ?? null;
    testWindow.__testEmitCandle = (payload) => latest("/events/candles")?.dispatchEvent(new MessageEvent("candle", { data: JSON.stringify(payload) }));
    testWindow.__testEmitPoolState = (payload) => latest("/events/pools")?.dispatchEvent(new MessageEvent("pool-state", { data: JSON.stringify(payload) }));
    testWindow.__testEmitPoolStateBatch = (payloads) => {
      const stream = latest("/events/pools");
      for (const payload of payloads) {
        stream?.dispatchEvent(new MessageEvent("pool-state", { data: JSON.stringify(payload) }));
      }
    };
    testWindow.__testHeartbeatPoolStream = () => {
      latest("/events/pools")?.dispatchEvent(new MessageEvent("heartbeat", { data: "{}" }));
    };
    const originalNow = Date.now;
    testWindow.__testAdvanceCandleClock = (milliseconds) => {
      Date.now = () => originalNow() + milliseconds;
    };
    testWindow.__testFailCandleStream = () => {
      const originalNow = Date.now;
      Date.now = () => originalNow() + 46_000;
      latest("/events/candles")?.onerror?.(new Event("error"));
      Date.now = originalNow;
    };
    testWindow.__testFailPoolStream = () => {
      const originalNow = Date.now;
      Date.now = () => originalNow() + 46_000;
      latest("/events/pools")?.onerror?.(new Event("error"));
      Date.now = originalNow;
    };
    testWindow.__testResetCandleStream = () => {
      latest("/events/candles")?.dispatchEvent(new MessageEvent("reset", { data: JSON.stringify({ cursor: "1000", reason: "canonical-reorg" }) }));
    };
    testWindow.__testResetPoolStream = () => {
      latest("/events/pools")?.dispatchEvent(new MessageEvent("reset", { data: JSON.stringify({ cursor: "1000", reason: "canonical-reorg" }) }));
    };
  });
}
