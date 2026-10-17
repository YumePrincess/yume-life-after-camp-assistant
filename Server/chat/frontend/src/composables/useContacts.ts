import { onDirectoryChange } from "../directory.js";
import { computed, ref } from "vue";
import type { UserSummary } from "../../../shared/user-profile.ts";
import api from "../api.js";

type ContactsApi = {
  getContacts: (options?: {
    signal?: AbortSignal;
  }) => Promise<{ users: UserSummary[] }>;
};

export function useContacts(contactsApi: ContactsApi = api) {
  const users = ref<UserSummary[]>([]);
  const query = ref("");
  const loading = ref(false);
  const error = ref("");
  let loaded = false;
  let reloadPending = false;
  let generation = 0;
  let controller: AbortController | null = null;
  const collator = new Intl.Collator(undefined, {
    sensitivity: "base",
    numeric: true,
  });

  const sortedUsers = computed(() =>
    [...users.value].sort((left, right) => {
      const leftName = left.displayName || left.username;
      const rightName = right.displayName || right.username;
      return (
        collator.compare(leftName, rightName) ||
        collator.compare(left.username, right.username) ||
        left.id - right.id
      );
    }),
  );
  const filteredUsers = computed(() => {
    const needle = query.value.trim().toLocaleLowerCase();
    if (!needle) return sortedUsers.value;
    return sortedUsers.value.filter((user) =>
      [user.displayName, user.username].some((value) =>
        String(value || "")
          .toLocaleLowerCase()
          .includes(needle),
      ),
    );
  });

  async function load(force = false, silent = false) {
    if (controller) {
      if (force) reloadPending = true;
      return;
    }
    if (loaded && !force) return;
    controller?.abort();
    controller = new AbortController();
    const request = ++generation;
    loading.value = !silent;
    error.value = "";
    try {
      const payload = await contactsApi.getContacts({
        signal: controller.signal,
      });
      if (request !== generation) return;
      users.value = payload.users;
      loaded = true;
    } catch (cause) {
      if (request !== generation) return;
      if (!silent) error.value = (cause as Error).message;
    } finally {
      if (request === generation) {
        loading.value = false;
        controller = null;
        if (reloadPending) {
          reloadPending = false;
          void load(true, true);
        }
      }
    }
  }

  const stopDirectory = onDirectoryChange(() => {
    void load(true, true);
  });
  function dispose() {
    stopDirectory();
    reloadPending = false;
    generation += 1;
    controller?.abort();
    controller = null;
  }

  return { users, query, loading, error, filteredUsers, load, dispose };
}
