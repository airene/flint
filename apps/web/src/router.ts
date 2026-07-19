import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/projects" },
    { path: "/projects", component: () => import("./views/ProjectsView.vue") },
    { path: "/projects/:projectId", component: () => import("./views/ProjectView.vue") },
    { path: "/tasks/:taskId", component: () => import("./views/TaskView.vue") },
    { path: "/settings", component: () => import("./views/SettingsView.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/projects" },
  ],
});
