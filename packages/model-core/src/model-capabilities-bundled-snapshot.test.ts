import { describe, expect, test } from "bun:test"

import { getBundledModelCapabilitiesSnapshot, getModelCapabilities } from "./model-capabilities"
import bundledModelCapabilitiesSnapshotJson from "../../../packages/omo-opencode/src/generated/model-capabilities.generated.json"

describe("bundled model capabilities snapshot", () => {
  test("resolves Kimi for Coding K3 to the image-capable supplemental entry", () => {
    const bundledSnapshot = getBundledModelCapabilitiesSnapshot(bundledModelCapabilitiesSnapshotJson)

    const result = getModelCapabilities({
      providerID: "kimi-for-coding",
      modelID: "k3",
      bundledSnapshot,
    })

    expect(result.canonicalModelID).toBe("kimi-k3")
    expect(result.modalities?.input).toEqual(["text", "image", "video"])
    expect(result.diagnostics).toMatchObject({
      resolutionMode: "alias-backed",
      canonicalization: {
        source: "pattern-alias",
        ruleID: "kimi-for-coding-k3-short-id-alias",
      },
      modalities: { source: "bundled-snapshot" },
    })
  })

  test("keeps GPT-4.1 OpenAI variants marked as supporting tool calls", () => {
    // given
    const bundledSnapshot = getBundledModelCapabilitiesSnapshot(bundledModelCapabilitiesSnapshotJson)
    const modelIDs = [
      "openai/gpt-4.1",
      "openai/gpt-4.1-mini",
      "openai/gpt-4.1-nano",
    ]

    // when
    const results = modelIDs.map((modelID) =>
      getModelCapabilities({
        providerID: "openai",
        modelID,
        bundledSnapshot,
      }),
    )

    // then
    for (const result of results) {
      expect(result.toolCall).toBe(true)
      expect(result.diagnostics).toMatchObject({
        resolutionMode: "snapshot-backed",
        snapshot: { source: "bundled-snapshot" },
        toolCall: { source: "bundled-snapshot" },
      })
    }
  })
})
