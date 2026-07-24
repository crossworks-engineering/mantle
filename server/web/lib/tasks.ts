/** Re-export from the shared workspace package. See @mantle/content. */
export {
  TASKS_ROOT_LABEL,
  TASK_STATUSES,
  TASK_PRIORITIES,
  listTasks,
  countTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  type TaskRow,
  type TaskStatus,
  type TaskPriority,
  type CreateTaskInput,
  type UpdateTaskInput,
} from '@mantle/content/tasks';
