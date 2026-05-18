import { Electroview } from "electrobun/view";

type AppRPC = {
  bun: {
    requests: {
      add: (a: { a: number; b: number }) => number;
      readSecret: () => string;
    };
    messages: {
      logFromView: (a: { msg: string }) => void;
    };
  };
  webview: {
    requests: { getViewTime: () => number };
    messages: { ping: (a: { n: number }) => void };
  };
};

console.log("test-page-loaded");
console.warn("a warning");
console.error("an error");

const rpc = Electroview.defineRPC<AppRPC>({
  handlers: {
    requests: {
      getViewTime: () => Date.now(),
    },
    messages: {
      ping: ({ n }) => {
        const log = document.getElementById("log")!;
        log.textContent += `ping ${n}\n`;
      },
    },
  },
});

const electroview = new Electroview({ rpc });

// Trigger network for the network tool
fetch("https://example.com/").catch(() => 0);

// Exercise both directions
(async () => {
  const sum = await electroview.rpc.request.add({ a: 3, b: 4 });
  const secret = await electroview.rpc.request.readSecret();
  document.getElementById("log")!.textContent = `sum=${sum} secret=${secret}\n`;
  electroview.rpc.send.logFromView({ msg: "view to bun fire-and-forget" });
})();
