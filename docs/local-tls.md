# Local TLS strategy

Development uses a local certificate authority and host certificates generated outside Git. Mount certificates into NGINX and EMQX through `certs/`; the directory is ignored except for its placeholder. Install the local CA only in development trust stores. Production certificates come from the approved environment operator and WSS, HTTPS, and MQTT/TLS must not be disabled.
