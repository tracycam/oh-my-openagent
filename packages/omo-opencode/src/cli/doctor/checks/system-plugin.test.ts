import { describe, expect, it } from "bun:test"

import { findPluginEntry } from "./system-plugin"

describe("findPluginEntry", () => {
  it("recognizes absolute local plugin paths as registered development entries", () => {
    expect(findPluginEntry(["/home/user/.cache/opencode/node_modules/oh-my-openagent"])).toEqual({
      entry: "/home/user/.cache/opencode/node_modules/oh-my-openagent",
      isLocalDev: true,
    })
  })

  it("recognizes Windows local plugin paths", () => {
    expect(findPluginEntry(["C:\\Users\\user\\opencode\\node_modules\\oh-my-openagent"])).toEqual({
      entry: "C:\\Users\\user\\opencode\\node_modules\\oh-my-openagent",
      isLocalDev: true,
    })
  })

  it("does not mistake a similarly named local directory for the plugin", () => {
    expect(findPluginEntry(["/tmp/oh-my-openagent-backup"])).toBeNull()
  })
})
