import { afterEach, describe, expect, test } from "bun:test"

import { resetMessageCursor } from "../../shared/session-cursor"
import { processMessages } from "./message-processor"

describe("processMessages", () => {
  afterEach(() => {
    resetMessageCursor()
  })

  test("#given a reused session has old assistant output #when processing with an anchor #then only output after the anchor is returned", async () => {
    // given
    const ctx = {
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: { id: "msg-old-assistant", role: "assistant", time: { created: 1 } },
                parts: [{ type: "text", text: "old answer" }],
              },
              {
                info: { id: "msg-new-user", role: "user", time: { created: 2 } },
                parts: [{ type: "text", text: "new prompt" }],
              },
              {
                info: { id: "msg-new-assistant", role: "assistant", time: { created: 3 } },
                parts: [{ type: "text", text: "new answer" }],
              },
            ],
          }),
        },
      },
    }

    // when
    const result = await processMessages("ses-reused", ctx as never, 1)

    // then
    expect(result).toBe("new answer")
  })

  test("#given a reused session only has an assistant skeleton after the anchor #when processing messages #then it rejects missing response content", async () => {
    // given
    const ctx = {
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: { id: "msg-old-assistant", role: "assistant", time: { created: 1 } },
                parts: [{ type: "text", text: "old answer" }],
              },
              {
                info: { id: "msg-new-user", role: "user", time: { created: 2 } },
                parts: [{ type: "text", text: "new prompt" }],
              },
              {
                info: { id: "msg-new-assistant", role: "assistant", time: { created: 3 } },
                parts: [],
              },
            ],
          }),
        },
      },
    }

    // when
    const result = processMessages("ses-reused-skeleton", ctx as never, 1)

    // then
    await expect(result).rejects.toThrow("No assistant or tool response content found")
  })
})
