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
  due?: { date: string } | null;
}

function dateOnly(value: string | undefined | null): string | null {
  if (!value) return null;
  return value.split("T")[0];
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

  const retriableStatuses = new Set([500, 502, 503, 504]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, options);
    if (res.ok) {
      return res.json() as Promise<T>;
    }
    if (retriableStatuses.has(res.status) && attempt === 0) {
      console.warn(
        `Todoist API ${method} ${path} returned ${res.status}; retrying in 3s...`
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    const text = await res.text();
    throw new Error(`Todoist API ${method} ${path} failed (${res.status}): ${text}`);
  }
  throw new Error(`Todoist API ${method} ${path} failed after retry`);
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
  const allTasks: TodoistTask[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({
      project_id: TODOIST_PROJECT_ID,
      limit: "200",
    });
    if (cursor) params.set("cursor", cursor);
    const page = await todoistRequest<{
      results: TodoistTask[];
      next_cursor: string | null;
    }>("GET", `/tasks?${params.toString()}`, token);
    if (!Array.isArray(page?.results)) {
      console.warn(
        `[A] ⚠️ Unexpected Todoist tasks response shape; treating as empty.`,
        page
      );
      break;
    }
    allTasks.push(...page.results);
    cursor = page.next_cursor;
  } while (cursor);
  return allTasks;
}

async function updateTodoistTaskDueDate(
  token: string,
  taskId: string,
  dueDate: string
): Promise<void> {
  await todoistRequest("POST", `/tasks/${taskId}`, token, { due_date: dueDate });
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

async function updateActionDueDate(
  client: DayAIClient,
  actionId: string,
  dueDate: string
): Promise<void> {
  await client.mcpCallTool("create_or_update_action", {
    actionId,
    dueDate,
  });
}

// --- Sync Logic ---

/**
 * Direction A: DayAI → Todoist
 * Find open Actions without todoist_task_id marker → create Todoist tasks.
 * For already-synced Actions, push timeframeEnd changes to Todoist due_date.
 */
async function syncDayAIToTodoist(
  client: DayAIClient,
  todoistToken: string,
  openActions: DayAIAction[]
): Promise<{ created: number; dueDateUpdated: number }> {
  const unsyncedActions = openActions.filter(
    (a) => !extractTodoistId(a.description)
  );

  let created = 0;
  if (unsyncedActions.length === 0) {
    console.log("[A] No unsynced actions found.");
  } else {
    console.log(`[A] Found ${unsyncedActions.length} unsynced action(s).`);
    for (const action of unsyncedActions) {
      try {
        const taskId = await createTodoistTask(todoistToken, action);
        const updatedDesc = (action.description || "").trimEnd() +
          `\n${TODOIST_MARKER_PREFIX}${taskId}`;
        await updateActionDescription(client, action.objectId, updatedDesc);
        console.log(`[A] ✅ Synced: "${action.title}" → Todoist task ${taskId}`);
        created++;
      } catch (err) {
        console.error(`[A] ❌ Failed to sync "${action.title}":`, err);
      }
    }
  }

  // Due-date push: for synced actions, reflect DayAI timeframeEnd to Todoist
  const syncedActions = openActions.filter(
    (a) => extractTodoistId(a.description) !== null
  );

  let dueDateUpdated = 0;
  if (syncedActions.length === 0) {
    return { created, dueDateUpdated };
  }

  const todoistTasks = await getTodoistProjectTasks(todoistToken);
  const todoistTaskMap = new Map(todoistTasks.map((t) => [t.id, t]));

  for (const action of syncedActions) {
    const taskId = extractTodoistId(action.description)!;
    const task = todoistTaskMap.get(taskId);
    if (!task) continue; // task may be completed/deleted; skip

    const dayaiDate = dateOnly(action.timeframeEnd);
    const todoistDate = dateOnly(task.due?.date);
    if (dayaiDate === todoistDate) continue;
    if (dayaiDate === null) continue; // do not clear Todoist due_date

    try {
      await updateTodoistTaskDueDate(todoistToken, taskId, dayaiDate);
      console.log(
        `[A] 📅 Updated Todoist due_date for "${action.title}": ${todoistDate ?? "(none)"} → ${dayaiDate}`
      );
      dueDateUpdated++;
    } catch (err) {
      console.error(`[A] ❌ Failed to update due_date for "${action.title}":`, err);
    }
  }

  return { created, dueDateUpdated };
}

/**
 * Direction B: Todoist → DayAI
 * Find synced Actions with open status, check Todoist completion → COMPLETED.
 * For active Todoist tasks, pull due_date changes back to DayAI timeframeEnd.
 */
async function syncTodoistToDayAI(
  client: DayAIClient,
  todoistToken: string,
  openActions: DayAIAction[]
): Promise<{ completed: number; dueDateUpdated: number }> {
  const syncedActions = openActions.filter(
    (a) => extractTodoistId(a.description) !== null
  );

  if (syncedActions.length === 0) {
    console.log("[B] No synced open actions to check.");
    return { completed: 0, dueDateUpdated: 0 };
  }

  console.log(`[B] Checking ${syncedActions.length} synced action(s) for Todoist completion.`);
  let completed = 0;
  let dueDateUpdated = 0;

  for (const action of syncedActions) {
    const taskId = extractTodoistId(action.description)!;
    try {
      const task = await getTodoistTask(todoistToken, taskId);
      if (task.checked || task.is_completed) {
        await completeAction(client, action.objectId);
        console.log(`[B] ✅ Completed: "${action.title}" (Todoist task ${taskId})`);
        completed++;
      } else {
        const todoistDate = dateOnly(task.due?.date);
        const dayaiDate = dateOnly(action.timeframeEnd);
        if (todoistDate !== null && todoistDate !== dayaiDate) {
          const isoDate = `${todoistDate}T00:00:00.000Z`;
          await updateActionDueDate(client, action.objectId, isoDate);
          console.log(
            `[B] 📅 Updated DayAI dueDate for "${action.title}": ${dayaiDate ?? "(none)"} → ${todoistDate}`
          );
          dueDateUpdated++;
        }
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

  return { completed, dueDateUpdated };
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
  let aResult = { created: 0, dueDateUpdated: 0 };
  try {
    aResult = await syncDayAIToTodoist(client, todoistToken, openActions);
  } catch (err) {
    console.error("[A] ❌ Direction A failed:", err);
  }

  // Direction B: Todoist → DayAI
  console.log("\n--- Direction B: Todoist → DayAI ---");
  let bResult = { completed: 0, dueDateUpdated: 0 };
  try {
    bResult = await syncTodoistToDayAI(client, todoistToken, openActions);
  } catch (err) {
    console.error("[B] ❌ Direction B failed:", err);
  }

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Actions created in Todoist: ${aResult.created}`);
  console.log(`Todoist due_dates updated (DayAI → Todoist): ${aResult.dueDateUpdated}`);
  console.log(`Actions completed from Todoist: ${bResult.completed}`);
  console.log(`DayAI dueDates updated (Todoist → DayAI): ${bResult.dueDateUpdated}`);
  console.log(`Finished at: ${new Date().toISOString()}`);
}

main().catch((err) => {
  // Log but always exit 0 so GitHub Actions doesn't treat transient failures as a job failure.
  console.error("Fatal error:", err);
  process.exit(0);
});
