import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Native portal browser module.
import * as skeleton from "../../web/skeleton.js";
const { beginSkeleton, skeletonTable, skeletonText } = skeleton;

class NodeStub {
  readonly attributes = new Map<string, string>();
  children: NodeStub[] = [];
  className = "";
  parent?: NodeStub;
  ownerDocument = { createElement: (tag: string) => new NodeStub(tag) };
  constructor(readonly tag = "div") {}
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  removeAttribute(key: string) {
    this.attributes.delete(key);
  }
  append(...nodes: NodeStub[]) {
    for (const node of nodes) node.parent = this;
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: NodeStub[]) {
    for (const node of this.children) node.parent = undefined;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (child) => child !== this,
      );
    this.parent = undefined;
  }
}

describe("CR-005 局部骨架生命周期", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it("快响应保留已有内容，120ms 内完成时不会创建骨架", () => {
    const host = new NodeStub(),
      old = new NodeStub();
    host.append(old);
    const draw = vi.fn(() => new NodeStub());
    const finish = beginSkeleton(host, draw);
    expect(host.attributes.get("aria-busy")).toBe("true");
    vi.advanceTimersByTime(119);
    finish();
    vi.runAllTimers();
    expect(draw).not.toHaveBeenCalled();
    expect(host.children).toEqual([old]);
    expect(host.attributes.has("aria-busy")).toBe(false);
  });
  it("慢响应占位只替换自己的内容区，旧请求收尾不能清掉新请求或完成态", () => {
    const host = new NodeStub(),
      first = new NodeStub(),
      second = new NodeStub();
    const endFirst = beginSkeleton(host, () => first);
    vi.advanceTimersByTime(120);
    expect(host.children).toEqual([first]);
    expect(first.attributes.get("aria-hidden")).toBe("true");
    const endSecond = beginSkeleton(host, () => second);
    endFirst();
    vi.advanceTimersByTime(120);
    expect(host.children).toEqual([second]);
    const result = new NodeStub();
    host.replaceChildren(result);
    endSecond();
    expect(host.children).toEqual([result]);
    expect(host.attributes.has("aria-busy")).toBe(false);
  });
  it("关闭抽屉前后均能取消，占位不会迟到", () => {
    for (const delay of [35, 150]) {
      const host = new NodeStub(),
        controller = new AbortController();
      beginSkeleton(host, () => new NodeStub(), { signal: controller.signal });
      vi.advanceTimersByTime(delay);
      controller.abort();
      vi.runAllTimers();
      expect(host.children).toHaveLength(0);
      expect(host.attributes.has("aria-busy")).toBe(false);
    }
  });
  it("已取消的请求不能撤下当前占位，连续慢读也不会闪回空白", () => {
    const host = new NodeStub(),
      first = new NodeStub(),
      second = new NodeStub();
    const stale = new AbortController();
    stale.abort();
    beginSkeleton(host, () => first);
    vi.advanceTimersByTime(120);
    beginSkeleton(host, () => new NodeStub(), { signal: stale.signal });
    expect(host.children).toEqual([first]);
    const finish = beginSkeleton(host, () => second);
    expect(host.children).toEqual([second]);
    finish();
  });
  it("按指定行列绘制表格和多行文本", () => {
    const doc = new NodeStub().ownerDocument;
    const table = skeletonTable(doc, 3, 4);
    const walk = (root: NodeStub): NodeStub[] => [
      root,
      ...root.children.flatMap(walk),
    ];
    const tags = walk(table).map((node) => node.tag);
    expect(tags.filter((t) => t === "td")).toHaveLength(12);
    expect(tags.filter((t) => t === "th")).toHaveLength(3);
    expect(skeletonText(doc, 2).children).toHaveLength(2);
  });
});
