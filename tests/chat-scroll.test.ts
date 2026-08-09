import assert from "node:assert/strict";
import test from "node:test";

import { createChatAutoFollow, isChatNearBottom } from "../src/renderer/src/lib/chat-scroll";

test("chat follows output only near the bottom of the message list", () => {
  assert.equal(isChatNearBottom({ scrollTop: 800, clientHeight: 400, scrollHeight: 1280 }), true);
  assert.equal(isChatNearBottom({ scrollTop: 700, clientHeight: 400, scrollHeight: 1280 }), false);
});

test("chat follow threshold includes exact boundary and short lists", () => {
  assert.equal(isChatNearBottom({ scrollTop: 784, clientHeight: 400, scrollHeight: 1280 }), true);
  assert.equal(isChatNearBottom({ scrollTop: 0, clientHeight: 600, scrollHeight: 400 }), true);
});

test("chat auto-follow owns pause, resume, and content scheduling", () => {
  const scheduled: Array<() => void> = [];
  const element = { scrollTop: 800, clientHeight: 400, scrollHeight: 1280 };
  const autoFollow = createChatAutoFollow((callback) => scheduled.push(callback));
  autoFollow.attach(element);

  autoFollow.onContentChanged(() => true);
  assert.equal(scheduled.length, 0, "initial content does not move the restored position");

  element.scrollTop = 600;
  autoFollow.onScroll(true);
  autoFollow.onContentChanged(() => true);
  assert.equal(scheduled.length, 0, "new output stays put while the reader is scrolled up");

  autoFollow.resume();
  autoFollow.onContentChanged(() => true);
  assert.equal(scheduled.length, 1);
  scheduled.shift()?.();
  assert.equal(element.scrollTop, element.scrollHeight);
});

test("chat auto-follow rechecks visibility before a scheduled scroll", () => {
  const scheduled: Array<() => void> = [];
  const element = { scrollTop: 800, clientHeight: 400, scrollHeight: 1280 };
  const autoFollow = createChatAutoFollow((callback) => scheduled.push(callback));
  let visible = true;
  autoFollow.attach(element);
  autoFollow.onContentChanged(() => visible);
  autoFollow.onContentChanged(() => visible);

  visible = false;
  scheduled.shift()?.();
  assert.equal(element.scrollTop, 800);
});
