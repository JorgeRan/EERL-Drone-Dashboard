import { useState } from "react";
import reactLogo from "./assets/react.svg";
import viteLogo from "/vite.svg";
import { tw, color } from "./constants/tailwind";
import { DeviceTabs } from "./components/Tabs";
import { MethanePanel } from "./components/MethanePanel";
import { Map } from "./components/Map";
import { WindPanel } from "./components/WindPanel";
import { Position } from "./components/3DPosition";

let devices = [
  {
    id: "device1",
    name: "M350",
    type: "Quadcopter",
    status: "online",
  },
  {
    id: "device2",
    name: "M400-1",
    type: "Hexacopter",
    status: "offline",
  },
  {
    id: "device3",
    name: "M400-2",
    type: "Octocopter",
    status: "warning",
  },
];

function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="flex min-h-screen flex-col bg-[#f8fafc] text-slate-900 font-sans">
      <DeviceTabs devices={devices} />
      <main
        className={`flex-1 bg-slate-100 ${color.text}`}
        style={{ backgroundColor: color.background, color: color.text }}
      >
        <section className={tw.shell}>
          <div className="grid w-full gap-3">
            <div className="grid w-full gap-3 xl:grid-cols-[1.4fr_0.8fr]">
              <Map />
              <Position />
            </div>
            <div className="grid w-full gap-3 xl:grid-cols-[1.8fr_0.6fr]">
              <MethanePanel />
              <WindPanel/>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
