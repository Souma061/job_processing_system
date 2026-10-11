import express from "express";
import { correlationMiddleware } from "./middleware/correlation.middleware.js";
import routes from "./routes/index.js";

const app = express();

// Core global middleware
app.use(express.json());
app.use(correlationMiddleware);

// Static file servers
app.use(express.static("public"));
app.use("/output", express.static("output"));
app.use("/uploads", express.static("uploads"));

// Mount all application routes
app.use("/", routes);

export default app;
