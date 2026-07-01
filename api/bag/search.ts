type ExpressHandler = (request: unknown, response: unknown) => unknown;

let appPromise: Promise<ExpressHandler> | null = null;

async function getApp() {
  appPromise ??= import("../../server/src/server.js").then(
    ({ createBagSearchApp }) => createBagSearchApp() as ExpressHandler
  );

  return appPromise;
}

export default async function handler(request: unknown, response: unknown) {
  const app = await getApp();
  return app(request, response);
}
