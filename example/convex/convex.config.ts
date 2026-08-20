import spectrum from "@spectrum-ts/convex/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(spectrum);

export default app;
