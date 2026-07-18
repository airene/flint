import { createRouter, createWebHistory } from "vue-router";
import ProjectView from "./views/ProjectView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import SettingsView from "./views/SettingsView.vue";
import TaskView from "./views/TaskView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/projects" },
    { path: "/projects", component: ProjectsView },
    { path: "/projects/:projectId", component: ProjectView },
    { path: "/tasks/:taskId", component: TaskView },
    { path: "/settings", component: SettingsView },
    { path: "/:pathMatch(.*)*", redirect: "/projects" },
  ],
});
