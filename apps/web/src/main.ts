import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import { useThemeStore } from "./stores/theme";
import "./styles.css";

const pinia = createPinia();
const app = createApp(App).use(pinia).use(router);

// Apply the persisted theme before mount so there is no flash of the wrong theme.
useThemeStore(pinia).init();

app.mount("#app");
