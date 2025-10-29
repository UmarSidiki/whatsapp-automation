import type { Application } from "express";
import authRoutes from "./authRoutes";
import aiRoutes from "./aiRoutes";
import qrRoutes from "./qrRoutes";
import healthRoutes from "./healthRoutes";
import messageRoutes from "./messageRoutes";
import personaRoutes from "./personaRoutes";

export default function registerRoutes(app: Application) {
  app.use(authRoutes);
  app.use(aiRoutes);
  app.use(messageRoutes);
  app.use("/persona", personaRoutes);
  app.use(qrRoutes);
  app.use(healthRoutes);
}
