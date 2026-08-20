import { httpRouter } from "convex/server";
import { spectrum } from "./spectrum";

const http = httpRouter();

// POST https://<deployment>.convex.site/spectrum/webhook
// Point your Spectrum Cloud webhook at this URL and set
// SPECTRUM_WEBHOOK_SECRET in the Convex dashboard.
spectrum.registerRoutes(http);

export default http;
