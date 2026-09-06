import type { INestApplication } from "@nestjs/common";
import { InvalidRentalJsonFilter } from "./invalid-rental-json.filter";

const defaultStorefrontOrigin = "http://localhost:3000";
const defaultAdminOrigin = "http://127.0.0.1:3200";

export function configureApi(app: INestApplication): INestApplication {
  app.setGlobalPrefix("api");
  app.enableCors({
    origin: [
      process.env.STOREFRONT_URL ?? defaultStorefrontOrigin,
      process.env.ADMIN_URL ?? defaultAdminOrigin,
    ],
  });
  app.useGlobalFilters(new InvalidRentalJsonFilter());

  return app;
}
