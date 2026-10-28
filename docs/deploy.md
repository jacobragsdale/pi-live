# Deploy the relay to AKS

This guide runs the pi-live relay in an AKS namespace you can deploy to, so colleagues on the corporate network and VPN can join your streams. Your pi reaches the relay through the cluster's HTTPS ingress. Guests reach it over SSH, through a private load balancer IP.

Prerequisites:

- `kubectl` access to a namespace where you can create Deployments, Services, Ingresses, ConfigMaps and Secrets
- Push access to a container registry the cluster pulls from, such as the team's Azure Container Registry, and `az` signed in with `az login`
- Docker, `nc` (`sudo apt install netcat-openbsd` in WSL), and a clone of this repo

Every command below uses `NS`. Set it in each terminal you use:

```bash
export NS=NAMESPACE
```

`NAMESPACE` is the namespace you deploy to. Here "the cloud team" means whoever runs the cluster; firewall rules may belong to a separate network team.

## Before the first deploy: the 10-minute check

Most of the setup sits inside your namespace. The check finds out which of the rest the cluster already gives you: an ingress class, a host name with a TLS certificate, permission for a private load balancer, and a network path for port 22. All of these commands are read-only:

```bash
for kind in deployments services ingresses configmaps secrets; do echo "$kind: $(kubectl auth can-i create $kind -n $NS)"; done
kubectl get ingress -n $NS -o custom-columns='NAME:.metadata.name,CLASS:.spec.ingressClassName,HOSTS:.spec.rules[*].host,TLS:.spec.tls[*].secretName'
kubectl get ingressclass
kubectl get svc -A -o wide | grep LoadBalancer
kubectl get constraints
```

The last three read the whole cluster. If one says `Forbidden`, you don't have cluster-wide read access, so ask the cloud team that question instead.

What the answers mean:

| Command                    | Look for                                                                                                                                                                                           | If not                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `auth can-i`               | `yes` five times                                                                                                                                                                                   | Ask the cloud team for the namespace's edit role.                                                                  |
| `get ingress`              | Other ingresses in your namespace. Their `CLASS` is the class to use. Hosts under a shared wildcard, such as `shop.apps.corp`, mean you can pick `pi-live.apps.corp` and reuse their `TLS` secret. | With no ingresses to copy, ask the cloud team which ingress class to use, and for a host name and TLS certificate. |
| `get ingressclass`         | The available classes, such as `nginx`, `webapprouting.kubernetes.azure.com` or `azure-application-gateway`. With several, use the one other teams' ingresses use.                                 | No class means no ingress controller. Ask the cloud team.                                                          |
| `get svc ... LoadBalancer` | A Service with a private `EXTERNAL-IP` (10.x, 172.16–31.x, 192.168.x), often the ingress controller's own. That shows the cluster can create internal load balancers.                              | No private ones: the cluster may never have made one. Step 6 will tell.                                            |
| `get constraints`          | No constraint whose name mentions load balancers or Service types. `the server doesn't have a resource type "constraints"` means no policy engine, so nothing blocks you.                          | A constraint that blocks `type: LoadBalancer` Services needs the cloud team.                                       |

The test that settles it comes after the deploy, in step 7: whether port 22 on the SSH IP is reachable from your workstation. If it isn't, this is the ticket you're most likely to need: "Please allow TCP 22 from the corporate and VPN ranges to `SSH_IP`." The private load balancer itself needs no Azure permissions of your own, because AKS creates it with the cluster's identity.

## Deploy

To deploy the relay:

1. Build the image and push it, tagged with the version in `package.json`:

   ```bash
   cd ~/dev/pi-live
   TAG=$(node -p 'require("./package.json").version')
   az acr login --name REGISTRY
   docker build -t REGISTRY.azurecr.io/pi-live:$TAG .
   docker push REGISTRY.azurecr.io/pi-live:$TAG
   ```

   `REGISTRY` is the registry's name.

2. Create the relay's SSH host key and store it in a Secret:

   ```bash
   ssh-keygen -t ed25519 -N "" -C pi-live -f host_key
   kubectl create secret generic pi-live-host-key --from-file=host_key -n $NS
   ssh-keygen -lf host_key.pub
   rm host_key host_key.pub
   ```

   The Secret is now the only copy of the key. Guests' ssh remembers it, so never delete the Secret; replacing it makes every guest's ssh warn. To keep a backup, store `host_key` in the team's Key Vault before the `rm`.

   The `ssh-keygen -lf` line prints the key's fingerprint, such as `256 SHA256:iismKMG72/XTgu8774vbIUU7nL9oIJfRgtTuPDEY2Xo pi-live (ED25519)`. Post it where guests can find it, such as the team channel. ssh shows it the first time they join, and matching it proves they reached your relay.

3. In `deploy/k8s/kustomization.yaml`, change the lines marked `CHANGE`:

   ```yaml
   namespace: NAMESPACE
   ...
   newName: REGISTRY.azurecr.io/pi-live
   newTag: "TAG"
   ...
   - PI_LIVE_JOIN_HOST=pi-live-ssh.example.corp
   ```

   `TAG` is the version from step 1. `PI_LIVE_JOIN_HOST` is what guests type after `ssh`. Leave it as it is for now: step 6 gives you the value.

4. In `deploy/k8s/ingress.yaml`, set `ingressClassName`, and `secretName` for the TLS secret. Put the host name you chose, such as `pi-live.apps.corp`, in both `tls.hosts` and `rules.host`. Without a host name and certificate you can still deploy, but your pi can't connect until you have them.
5. Apply the manifests:

   ```bash
   kubectl apply -k deploy/k8s
   kubectl rollout status deployment/pi-live -n $NS
   ```

   Success prints `deployment "pi-live" successfully rolled out`. If it hangs, run `kubectl get pods -n $NS`:
   - `CrashLoopBackOff`: read the reason with `kubectl logs deployment/pi-live -n $NS`. `can't start: there is no SSH host key` means the Secret from step 2 is missing or in another namespace.
   - `ImagePullBackOff`: the cluster can't pull from your registry. Check the image name and tag, or ask the cloud team to give the cluster pull access.

6. Get the SSH load balancer's IP from the `EXTERNAL-IP` column. It shows `<pending>` for a minute or two:

   ```bash
   kubectl get svc pi-live-ssh -n $NS
   ```

   The IP must be private (10.x, 172.16–31.x, 192.168.x). If it stays `<pending>`, run `kubectl describe svc pi-live-ssh -n $NS`. The events name the Azure error, such as a policy denial, or the cluster's identity lacking rights on the subnet. Either one needs the cloud team.

   Set `PI_LIVE_JOIN_HOST` in `kustomization.yaml` to the IP, or to a DNS name for it (the cloud team adds the record to the private DNS zone). Run `kubectl apply -k deploy/k8s` again; the relay restarts with the new value. To keep the IP if the Service is ever re-created, uncomment the `azure-load-balancer-ipv4` annotation in `service-ssh.yaml` and put the IP there.

7. From WSL on your workstation, check that SSH is reachable:

   ```bash
   nc -vz -w 5 SSH_IP 22
   ```

   `SSH_IP` is the IP from step 6.
   - `Connection to SSH_IP 22 port [tcp/ssh] succeeded!` means the network is done.
   - `Connection refused` means you reached the IP but nothing answered. Check that the pod is running (step 5).
   - A timeout means a firewall or network security group is dropping port 22. File the ticket from the 10-minute check. Meanwhile, try the port 443 workaround below.

8. Point pi at the relay, in `~/.pi/agent/live.json`, using the host name from `ingress.yaml`, then restart pi or run `/reload`:

   ```json
   { "url": "wss://pi-live.apps.corp/host" }
   ```

To confirm it worked:

1. Run `/live` in pi. It prints the command guests will run, `ssh TOKEN@JOIN_HOST`.
2. Join from a second terminal with that command. ssh shows the fingerprint from step 2.
3. Check the relay's log, which shows `YOUR_NAME opened a stream with pi 1.4.0`:

   ```bash
   kubectl logs deployment/pi-live -n $NS
   ```

## If port 22 is blocked

Firewalls that filter only by port often already allow 443 into the cluster's network. This workaround serves SSH on port 443 of the same private IP. To switch to it:

1. In `service-ssh.yaml`, change `port: 22` to `port: 443`.
2. In `kustomization.yaml`, set `PI_LIVE_JOIN_PORT=443`.
3. Run `kubectl apply -k deploy/k8s`, then `nc -vz -w 5 SSH_IP 443`.

The join command becomes `ssh -p 443 TOKEN@JOIN_HOST`. A firewall that inspects traffic still sees that it is SSH and may drop it. Then the ticket is the only fix.

If SSH can't get through at all, the relay could serve the same view to a browser over the HTTPS ingress. That isn't built; see [Why SSH](design.md#why-ssh).

## A guest's ssh times out

If your own `ssh` to the join command works but a guest's times out:

1. Check that the guest ran the exact line `/live` printed, and that its host isn't the `pi-live-ssh.example.corp` placeholder. That would mean `PI_LIVE_JOIN_HOST` was never set (step 6).
2. Ask the guest to run `nc -vz -w 5 JOIN_HOST 22` (or `443`). A timeout for them but not for you usually means their network range isn't allowed. Note whether they're on VPN or in an office, and add that range to the firewall ticket.

## Keep the relay running

- The Deployment must stay at one replica with the `Recreate` strategy. Streams live in the pod's memory, so a host and their guests must reach the same pod. A rollout or restart ends every open stream; hosts run `/live` again for a new link.
- When you upgrade pi, bump the pi packages and the `version` in `package.json`, and run the tests. Then build and push the new tag (step 1), set `newTag`, and apply again. Until then `/live` warns that the relay draws with a different pi.
- If you ever replace the host key, guests' ssh warns `REMOTE HOST IDENTIFICATION HAS CHANGED`. Each guest removes the old key with `ssh-keygen -R JOIN_HOST`, or `ssh-keygen -R '[JOIN_HOST]:443'` if you moved SSH to port 443.

For every relay setting, see [Settings](../README.md#settings).
