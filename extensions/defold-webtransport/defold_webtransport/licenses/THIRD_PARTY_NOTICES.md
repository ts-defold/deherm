# Third-party notices

The native Defold WebTransport libraries contain the following pinned
third-party software. The distributed binaries use Mbed TLS under the
Apache-2.0 option.

| Component | Revision | License | Upstream |
| --- | --- | --- | --- |
| picoquic, h3zero, picowt | `8616f9d402cf886ade825e299e781a24fb4293db` | MIT | <https://github.com/private-octopus/picoquic> |
| picotls | `bfa67875982afc4c24f21e146cef4747fa189c2f` | MIT | <https://github.com/h2o/picotls> |
| cifra, bundled by picotls minicrypto | picotls submodule at the revision above | CC0-1.0 | <https://github.com/ctz/cifra> |
| micro-ecc, bundled by picotls minicrypto | picotls submodule at the revision above | BSD-2-Clause | <https://github.com/kmackay/micro-ecc> |
| Mbed TLS 3.6.7 | `068ff080b369adfac81509f9b57b2afabaf82dc5` | Apache-2.0 | <https://github.com/Mbed-TLS/mbedtls> |
| mbedtls-framework | `dde0c4a0e448a0552f18817dcea633bb851fd288` | Apache-2.0 | <https://github.com/Mbed-TLS/mbedtls-framework> |

The exact license texts required by these binary dependencies are included in
this directory. Source identities are also part of the native artifact
fingerprint; changing one requires a new content-addressed artifact release.
