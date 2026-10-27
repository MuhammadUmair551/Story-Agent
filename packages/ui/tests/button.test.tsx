import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, GeckoMascot } from "../src/index.js";

void test("Button composes its shadcn styles onto an accessible child action", (): void => {
  const markup = renderToStaticMarkup(
    <Button asChild variant="outline">
      <a href="/health">Health</a>
    </Button>
  );

  assert.match(markup, /^<a /);
  assert.match(markup, /border-input/);
  assert.match(markup, /href="\/health"/);
});

void test("GeckoMascot uses the supplied PNG asset and keeps the state hook", (): void => {
  const markup = renderToStaticMarkup(<GeckoMascot state="thinking" className="size-10" />);

  assert.match(markup, /aria-hidden="true"/);
  assert.match(markup, /src="\/images\/gecko-mascot\.png"/);
  assert.match(markup, /gecko-mascot--thinking/);
});

void test("GeckoMascot preserves the shared interaction-state variants for layout hooks", (): void => {
  const happy = renderToStaticMarkup(<GeckoMascot state="happy" />);
  const speaking = renderToStaticMarkup(<GeckoMascot state="speaking" />);

  assert.match(happy, /gecko-mascot--happy/);
  assert.match(speaking, /gecko-mascot--speaking/);
  assert.match(happy, /src="\/images\/gecko-mascot\.png"/);
});
