import { expect, it } from "vitest";
import { createAutomationLocksRepository } from "../db/repositories/automation-locks";
import { createScheduledTaskConversationRepository } from "../db/repositories/scheduled-task-conversations";
import { createUserRepository } from "../db/repositories/users";
import { createTestDb, createTestPgDb } from "../test-utils";
import { createAutomationTaskConversationService } from "./task-conversations";

it.each(["sqlite", "postgres"])("renews only the existing live builder generation on %s", async (dialect) => {
  const db = await (dialect === "sqlite" ? createTestDb() : createTestPgDb());
  try {
    const taskId = "builder-renewal-fixture";
    const conversationId = "builder-renewal-chat";
    const userId = (
      await createUserRepository(db).create({ name: "Fixture", email: "renewal@example.com", emailVerified: true })
    ).id;
    const service = createAutomationTaskConversationService(db);
    const locks = createAutomationLocksRepository(db);
    await createScheduledTaskConversationRepository(db).upsert({
      taskId,
      conversationId,
      transcriptUserId: userId,
      kind: "builder",
    });
    const lease = { clientSessionId: "first-browser", generation: 1 };
    expect((await service.acquireBuilderConversationLock(taskId, conversationId, userId, lease)).kind).toBe("active");
    const renew = (generation = 1) =>
      service.acquireBuilderConversationLock(taskId, conversationId, userId, {
        clientSessionId: "second-browser",
        generation,
        renewOnly: true,
      });
    const oldExpiry = new Date(Date.now() + 10_000).toISOString();
    await db
      .updateTable("automation_task_locks")
      .set({ expires_at: oldExpiry })
      .where("task_id", "=", taskId)
      .execute();
    expect((await renew()).kind).toBe("active");
    expect((await locks.getByTaskId(taskId))?.expires_at).not.toBe(oldExpiry);
    expect((await locks.getByTaskId(taskId))?.generation).toBe(1);

    await db.updateTable("automation_task_locks").set({ generation: 2 }).where("task_id", "=", taskId).execute();
    expect((await renew()).kind).toBe("stale");
    const expiry = "2000-01-01T00:00:00.000Z";
    await db.updateTable("automation_task_locks").set({ expires_at: expiry }).where("task_id", "=", taskId).execute();
    expect((await renew(2)).kind).toBe("stale");
    expect(await locks.getByTaskId(taskId)).toMatchObject({ generation: 2, expires_at: expiry });

    await locks.deleteByTaskId(taskId);
    expect((await renew(2)).kind).toBe("stale");
    expect(await locks.getByTaskId(taskId)).toBeUndefined();
  } finally {
    await db.destroy();
  }
});
