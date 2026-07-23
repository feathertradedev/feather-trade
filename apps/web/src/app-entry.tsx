import { App } from "./App";
import { initializeWalletModal } from "./wagmi";
import "./styles.css";

// Reown's WagmiAdapter installs account/connector watchers synchronously when
// AppKit is created. Do that before React mounts WagmiProvider, but do not make
// rendering depend on AppKit's remote configuration and usage requests.
initializeWalletModal();

export default App;
