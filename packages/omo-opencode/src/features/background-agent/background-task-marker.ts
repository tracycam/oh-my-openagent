import { setContinuationMarkerSource } from "../run-continuation-state"

export type BackgroundTaskMarkerInput = {
  readonly directory: string
  readonly parentSessionID: string
  readonly activeTaskCount: number
}

export function writeBackgroundTaskMarker(input: BackgroundTaskMarkerInput): void {
  if (input.activeTaskCount > 0) {
    setContinuationMarkerSource(
      input.directory,
      input.parentSessionID,
      "background-task",
      "active",
      `${input.activeTaskCount} background task(s) active`,
    )
    return
  }

  setContinuationMarkerSource(
    input.directory,
    input.parentSessionID,
    "background-task",
    "idle",
  )
}
