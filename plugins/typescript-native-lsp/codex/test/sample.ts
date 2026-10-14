/** Represents a user in the system */
interface User {
  id: string
  name: string
  email: string
  createdAt: Date
}

/** Configuration for creating a workflow */
interface WorkflowConfig {
  name: string
  steps: WorkflowStep[]
  timeout?: number
}

interface WorkflowStep {
  id: string
  action: "fetch" | "transform" | "validate"
  params: Record<string, unknown>
}

/** A workflow instance */
interface Workflow {
  id: string
  config: WorkflowConfig
  status: "pending" | "running" | "completed" | "failed"
  run: () => Promise<void>
}

/**
 * Creates a new workflow from configuration
 *
 * @example
 *   const workflow = createWorkflow({ name: "test", steps: [] })
 *
 * @param config - The workflow configuration
 */
function createWorkflow(config: WorkflowConfig): Workflow {
  return {
    id: crypto.randomUUID(),
    config,
    status: "pending",
    run: async () => {
      console.log(`Running workflow: ${config.name}`)
    },
  }
}

// Example usage
const user: User = {
  id: "123",
  name: "Alice",
  email: "alice@example.com",
  createdAt: new Date(),
}

const workflow = createWorkflow({
  name: "User onboarding",
  steps: [
    { id: "1", action: "fetch", params: { url: "/api/user" } },
    { id: "2", action: "validate", params: { schema: "user" } },
  ],
})

type ExtractStepAction<T> = T extends { action: infer A } ? A : never
type StepAction = ExtractStepAction<WorkflowStep>

export {
  type User,
  type WorkflowConfig,
  type Workflow,
  createWorkflow,
  user,
  workflow,
}
