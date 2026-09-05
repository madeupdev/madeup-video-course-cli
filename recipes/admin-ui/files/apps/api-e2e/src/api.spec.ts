import { afterEach, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { AppModule } from "../../api/src/app/app.module";
import { configureApi } from "../../api/src/app/configure-api";

describe("API shell", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("reports readiness over real HTTP", async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    configureApi(app);
    await app.listen(0, "127.0.0.1");

    const response = await fetch(`${await app.getUrl()}/api/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("permits mutation preflights from the normal development storefront", async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    configureApi(app);
    await app.listen(0, "127.0.0.1");

    const response = await fetch(`${await app.getUrl()}/api/rentals`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "POST",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
  });

  it("permits requests from the default local admin application origin", async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    configureApi(app);
    await app.listen(0, "127.0.0.1");

    const response = await fetch(`${await app.getUrl()}/api/titles`, {
      headers: { origin: "http://127.0.0.1:3200" },
    });

    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:3200",
    );
  });
});
