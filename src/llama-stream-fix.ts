// workers-ai-provider 3.x (the last line compatible with AI SDK v6, which @cloudflare/ai-chat
// uses) emits Llama 3.3 output twice: each stream chunk carries the text in both `response`
// and `choices[0].delta.content`, and tool-call arguments in both `tool_calls` and
// `choices[0].delta.tool_calls`, and the provider reads both copies. Fixed in 4.x, which needs
// AI SDK v7. Until then, strip the native copies from chunks that also carry an OpenAI delta.

function dedupeSse(
  stream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const fixLine = (line: string): string => {
    if (!line.startsWith("data:")) return line;
    const payload = line.slice(5).trim();
    if (!payload.startsWith("{")) return line; // e.g. "[DONE]"
    try {
      const chunk = JSON.parse(payload) as {
        response?: unknown;
        tool_calls?: unknown;
        choices?: { delta?: unknown }[];
      };
      if (
        chunk.choices?.[0]?.delta &&
        ("response" in chunk || "tool_calls" in chunk)
      ) {
        delete chunk.response;
        delete chunk.tool_calls;
        return `data: ${JSON.stringify(chunk)}`;
      }
    } catch {
      // not JSON; pass through untouched
    }
    return line;
  };

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        buffer += decoder.decode(bytes, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines)
          controller.enqueue(encoder.encode(`${fixLine(line)}\n`));
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) controller.enqueue(encoder.encode(fixLine(buffer)));
      }
    })
  );
}

/** Wrap a Workers AI binding so streamed responses don't duplicate text. */
export function withDedupedStreams(ai: Ai): Ai {
  return new Proxy(ai, {
    get(target, prop, receiver) {
      if (prop !== "run") return Reflect.get(target, prop, receiver);
      return async (...args: Parameters<Ai["run"]>) => {
        const result = await (
          target.run as (...a: unknown[]) => Promise<unknown>
        )(...args);
        return result instanceof ReadableStream ? dedupeSse(result) : result;
      };
    }
  });
}
