/**
 * DayAI Actions ↔ Todoist Bidirectional Sync
 *
 * Direction A: DayAI → Todoist (new Action → create Todoist task)
 * Direction B: Todoist → DayAI (completed task → COMPLETED Action)
 *
 * Designed to run as a GitHub Actions cron job every 5 minutes.
 * Uses DayAI SDK (OAuth + MCP) and Todoist REST API v1.
 */

import { DayAIClient } from "./index";

// --- Configuration ---
const TODOIST_API_BASE = "https://api.todoist.com/api/v1";
const TODOIST_PROJECT_ID = "6gV2q33Q54fQqcgC";
const OWNER_EMAIL = "kohjitani.hirohiko.7z@kyoto-u.ac.jp";
const TODOIST_MARKER_PREFIX = "todoist_task_id:";
const DAYAI_MARKER_PREFIX = "dayai:";

// --- Types ---
interface DayAIAction {
  objectId: string;
  title: string;
  description?: string;
  descriptionPoints?: string[];
  status: string;
  priority?: string;
  timeframeEnd?: string;
}

interface TodoistTask {
  id: string;
  content: string;
  description: string;
  is_completed: boolean;
  checked: boolean;
  project_id: string;
}

// --- Todoist API helpers ---
async function todoistRequest<T>(
  method: string,
  path: string,
  token: string,
  body?: Record<string, unknown>
): Promise<T> {
  const url = `${TODOIST_API_BASE}${path}`;
  const options: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Todoist API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

async function createTodoistTask(
  token: string,
  action: DayAIAction
): Promise<string> {
  const description = `${DAYAI_MARKER_PREFIX}${action.objectId}\n---\n${action.description || ""}`;

  const priorityMap: Record<string, number> = {
    URGENT: 4,
    HIGH: 4,
    MEDIUM: 3,
    LOW: 2,
  };

  const body: Record<string, unknown> = {
    content: action.title,
    description,
    project_id: TODOIST_PROJECT_ID,
    priority: priorityMap[action.priority || ""] || 1,
  };

  if (action.timeframeEnd) {
    // Todoist expects YYYY-MM-DD or ISO datetime
    body.due_date = action.timeframeEnd.split("T")[0];
  }

  const task = await todoistRequest<{ id: string }>("POST", "/tasks", token, body);
  return task.id;
}

async function getTodoistTask(
  token: string,
  taskId: string
): Promise<TodoistTask> {
  return todoistRequest<TodoistTask>("GET", `/tasks/${taskId}`, token);
}

async function getTodoistProjectTasks(
  token: string
): Promise<TodoistTask[]> {
  return todoistRequest<TodoistTask[]>(
    "GET",
    `/tasks?project_id=${TODOIST_PROJECT_ID}`,
    token
  );
}

// --- DayAI helpers ---
function extractTodoistId(description: string | undefined): string | null {
  if (!description) return null;
  const match = description.match(new RegExp(`${TODOIST_MARKER_PREFIX}(\\S+)`));
  return match ? match[1] : null;
}

function extractDayAIId(description: string | undefined): string | null {
  if (!description) return null;
  const match = description.match(new RegExp(`${DAYAI_MARKER_PREFIX}([a-f0-9-]+)`));
  return match ? match[1] : null;
}

async function fetchOpenActions(client: DayAIClient): Promise<DayAIAction[]> {
  const allActions: DayAIAction[] = [];
  let offset = 0;
  const pageSize = 50;

  while (true) {
    const result = await client.mcpCallTool("search_objects", {
      queries: [
        {
          objectType: "native_action",
          where: {
            AND: [
              {
                propertyId: "ownerEmail",
                operator: "eq",
                value: OWNER_EMAIL,
              },
              {
                propertyId: "status",
                operator: "isAnyOf",
                value: ["UNREAD", "READ", "IN_PROGRESS"],
              },
            ],
          },
        },
      ],
      propertiesToReturn: ["title", "description", "descriptionPoints", "status", "priority", "timeframeEnd"],
      offset,
    });

    const data = JSON.parse((result.data as any).content[0].text);
    const actions = data.native_action?.results || [];

    for (const a of actions) {
      allActions.push({
        objectId: a.objectId,
        title: a.title || a.properties?.title || "",
        description: a.properties?.description || a.description || "",
        descriptionPoints: a.properties?.descriptionPoints || [],
        status: a.properties?.status || a.status || "",
        priority: a.properties?.priority || "",
        timeframeEnd: a.properties?.timeframeEnd || "",
      });
    }

    if (!data.hasMore || actions.length < pageSize) break;
    offset = data.nextOffset || offset + pageSize;
  }

  return allActions;
}

async function updateActionDescription(
  client: DayAIClient,
  actionId: string,
  newDescription: string
): Promise<void> {
  await client.mcpCallTool("create_or_update_action", {
    actionId,
    description: newDescription,
  });
}

async function completeAction(
  client: DayAIClient,
  actionId: string
): Promise<void> {
  await client.mcpCallTool("create_or_update_action", {
    actionId,
    status: "COMPLETED",
  });
}

// --- Sync Logic ---

/**
 * Direction A: DayAI → Todoist
 * Find open Actions without todoist_task_id marker → create Todoist tasks
 */
async function syncDayAIToTodoist(
  client: DayAIClient,
  todoistToken: string,
  openActions: DayAIAction[]
): Promise<number> {
  const unsyncedActions = openActions.filter(
    (a) => !extractTodoistId(a.description)
  );

  if (unsyncedActions.length === 0) {
    console.log("[A] No unsynced actions found.");
    return 0;
  }

  console.log(`[A] Found ${unsyncedActions.length} unsynced action(s).`);
  let synced = 0;

  for (const action of unsyncedActions) {
    try {
      const taskId = await createTodoistTask(todoistToken, action);
      const updatedDesc = (action.description || "").trimEnd() +
        `\n${TODOIST_MARKER_PREFIX}${taskId}`;
      await updateActionDescription(client, action.objectId, updatedDesc);
      console.log(`[A] ✅ Synced: "${action.title}" → Todoist task ${taskId}`);
      synced++;
    } catch (err) {
      console.error(`[A] ❌ Failed to sync "${action.title}":`, err);
    }
  }

  return synced;
}

/**
 * Direction B: Todoist → DayAI
 * Find synced Actions with open status, check Todoist completion → COMPLETED
 */
async function syncTodoistToDayAI(
  client: DayAIClient,
  todoistToken: string,
  openActions: DayAIAction[]
): Promise<number> {
  const syncedActions = openActions.filter(
    (a) => extractTodoistId(a.description) !== null
  );

  if (syncedActions.length === 0) {
    console.log("[B] No synced open actions to check.");
    return 0;
  }

  console.log(`[B] Checking ${syncedActions.length} synced action(s) for Todoist completion.`);
  let completed = 0;

  for (const action of syncedActions) {
    const taskId = extractTodoistId(action.description)!;
    try {
      const task = await getTodoistTask(todoistToken, taskId);
      if (task.checked || task.is_completed) {
        await completeAction(client, action.objectId);
        console.log(`[B] ✅ Completed: "${action.title}" (Todoist task ${taskId})`);
        completed++;
      }
    } catch (err: any) {
      // Task might have been deleted in Todoist
      if (err.message?.includes("404")) {
        console.warn(`[B] ⚠️ Todoist task ${taskId} not found for "${action.title}" — skipping.`);
      } else {
        console.error(`[B] ❌ Failed to check "${action.title}":`, err);
      }
    }
  }

  return completed;
}

// --- Main ---
async function main() {
  const todoistToken = process.env.TODOIST_API_TOKEN;
  if (!todoistToken) {
    throw new Error("TODOIST_API_TOKEN environment variable is required");
  }

  console.log("=== DayAI ↔ Todoist Sync ===");
  console.log(`Started at: ${new Date().toISOString()}`);

  const client = new DayAIClient();

  // Fetch open actions once (used by both directions)
  console.log("\nFetching open DayAI actions...");
  const openActions = await fetchOpenActions(client);
  console.log(`Found ${openActions.length} open action(s).`);

  // Direction A: DayAI → Todoist
  console.log("\n--- Direction A: DayAI → Todoist ---");
  const syncedToTodoist = await syncDayAIToTodoist(client, todoistToken, openActions);

  // Direction B: Todoist → DayAI
  console.log("\n--- Direction B: Todoist → DayAI ---");
  const completedFromTodoist = await syncTodoistToDayAI(client, todoistToken, openActions);

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Actions synced to Todoist: ${syncedToTodoist}`);
  console.log(`Actions completed from Todoist: ${completedFromTodoist}`);
  console.log(`Finished at: ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
