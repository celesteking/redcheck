## Reasoning

* **Simplicity**: You need a reliable _Redis_ infrastructure, but don't want redis clients to care about _sentinel_ stuff, you want sentinel to be transparent to clients with no modifications required on clients' side.

* **Security**: You don't want to expose _sentinel_ infrastructure to clients. You don't want to expose _redis_ infrastructure to clients.

* **Control**: You want to restrict, control, monitor client connections via _HAProxy_, for whatever purpose and reasons those might be.

## Purpose

This tiny tool will help you tie _Redis Sentinel_ and _HAProxy_ together.
 
The recommended way to run _Redis Sentinel_ "high availability" feature is to let the clients talk to sentinels. This requires sentinel awareness in client libs.
There are cases (outlined above) where you need just plain old redis proto on clients and nothing else. HAProxy and this tool will help you achieve that. 

## Alternatives

> You will lose(*) data in any case. If you don't want to, you'll have to shell out $$ for their commercial solution.

* [haproxy "who's the master" check](https://www.haproxy.com/blog/haproxy-advanced-redis-health-check/) + `sentinel client-reconfig-script` updating haproxy state
* clients with sentinel support

(*) "real-time" data, or the one expected to arrive at a given time. You can substitute "lose" with "delay", but that will need support from the client.

## Implementation and notes

The general idea is simple: Subscribe to `+switch-master` channel on sentinel and when message arrives, update the haproxy *map*, which is used to lookup the backend.

This script incorporates some logic to defend against sentinel "wrongdoing" (in split brain situations?), but don't expect much. You have to understand how sentinel stuff works and have it properly configured before trying to blame this script.

On startup, it will connect to first sentinel to retrieve and update master IP. After that, it will wait for master change event indefinitely. It will maintain connections to all specified sentinels, otherwise this all wouldn't make sense. On connection breakage, it will try (thanks to _ioredis_) to reconnect indefinitely. On master change, it will connect to haproxy socket, update map with new master IP, kill sessions on old master IP backend (1 backend = 1 server), then save the map file (just in case haproxy gets restarted).

## Installation & configuration

Assuming you have already set up redis servers, redis sentinels and have tested that the failover works, set this script up on an haproxy instance. Make sure to use unprivileged account (let's call the username _REDCHECKUSER_)

Sample `haproxy.cfg` is provided. Use it to update your haproxy config. After that, make sure map file is writable:

      mkdir -p /etc/haproxy/maps/
      chmod 0711 /etc/haproxy/maps/
      touch /etc/haproxy/maps/redmaster
      chown REDCHECKUSER /etc/haproxy/maps/redmaster

You will have to update settings in the script and haproxy config. Script's settings are self-explanatory. 

## Contributors

Work sponsored by [Fused Web Hosting](https://www.fused.com)
