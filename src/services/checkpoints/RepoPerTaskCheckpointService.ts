import * as path from "path"

import { CheckpointServiceOptions } from "./types"
import { ShadowCheckpointService } from "./ShadowCheckpointService"
import { resolveProjectTaskDirectory } from "../kilocode/project-task-storage" // kilocode_change

export class RepoPerTaskCheckpointService extends ShadowCheckpointService {
	public static create({ taskId, workspaceDir, shadowDir, log = console.log }: CheckpointServiceOptions) {
		return new RepoPerTaskCheckpointService(
			taskId,
			path.join(resolveProjectTaskDirectory(taskId) ?? path.join(shadowDir, "tasks", taskId), "checkpoints"), // kilocode_change
			workspaceDir,
			log,
		)
	}
}
