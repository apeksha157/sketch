import { setScryptOptions } from "./auth/password";

/** Use minimum scrypt cost in tests (~0.1ms vs ~22ms per hash). */
setScryptOptions({ N: 2 });
