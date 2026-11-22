import { createRouter, createMemoryHistory } from "vue-router";
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    {
      path: "/",
      name: "chat",
      component: () => import("./pages/ChatPage.vue"),
      meta: { workspace: true },
    },
    {
      path: "/contacts",
      name: "contacts",
      component: () => import("./pages/ChatPage.vue"),
      meta: { workspace: true },
    },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
export default router;
