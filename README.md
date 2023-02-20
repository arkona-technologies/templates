![alt text](https://cdn.bitrix24.com/b16399145/landing/3dd/3dd1402246d6a5d670a3f64afd1b8897/Arkona_BladeRunner_Logo_294.137_1x.png)

Currently, this project contains a single template only that will set up a AT300 SDI/IP gateway by routing all SDI inputs to 2110-20/30/40 transmitters, and initializing receiver sessions that feed into the blade's current set of SDI outputs. If the blade is found to be equipped with a reconfigurable IO module, the first half of its BNC ports will be configured to act as inputs.

Every SDI input is furthermore protected against signal loss by a framesync instance, and routed through a "1D" color correction instance.

To execute the gateway script, please first initialize the project directory via

``` sh
IP=<your-at300-ip-address> npm run setup
```

where `IP` should be set to the IP address of your AT300. The gateway script itself can then be executed via

``` sh
IP=<your-at300-ip-address> npm run gateway-dynamic-ips
```

where multicast destination addresses are programmatically inferred from `IP`, or via

``` sh
IP=<your-at300-ip-address> npm run gateway-static-ips
```

where multicast destination addresses are read from the file `ip-processing-gateway/example_address_schema.json`.


If you wish to use HTTP Basic Auth you may also access the script and it's set of cli arguments via
```sh 
npm run gateway -- --help
```
