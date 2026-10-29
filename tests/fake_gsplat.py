"""Tiny differentiable stand-in for the gsplat calls namma.trainer uses, for CPU/GPU tests without gsplat.

It splats isotropic Gaussians with DC colour only and composites them front to back. It is NOT a
replacement for gsplat: it only lets the pipeline's data flow, losses, checkpoints and exports run.
"""
from types import SimpleNamespace

import torch
import torch.nn.functional as F

SH_C0 = 0.28209479177387814


def rasterization(means, quats, scales, opacities, colors, viewmats, Ks, width, height, sh_degree=None,
                  render_mode="RGB", **_):
    w2c, K = viewmats[0], Ks[0]
    cam = means @ w2c[:3, :3].T + w2c[:3, 3]
    z = cam[:, 2]
    keep = z > 0.05
    cam, z, scales, opacities, rgb = cam[keep], z[keep], scales[keep], opacities[keep], colors[keep, 0] * SH_C0 + 0.5
    u = K[0, 0] * cam[:, 0] / z + K[0, 2]
    v = K[1, 1] * cam[:, 1] / z + K[1, 2]
    radius = (K[0, 0] * scales.mean(-1) / z).clamp(0.5, 40.0)
    ys, xs = torch.meshgrid(torch.arange(height, device=means.device) + 0.5,
                            torch.arange(width, device=means.device) + 0.5, indexing="ij")
    order = torch.argsort(z)
    d2 = (xs.reshape(1, -1) - u[order, None]) ** 2 + (ys.reshape(1, -1) - v[order, None]) ** 2
    alpha = (opacities[order, None] * torch.exp(-0.5 * d2 / radius[order, None] ** 2)).clamp(max=0.99)
    transmit = torch.cumprod(torch.cat([torch.ones_like(alpha[:1]), 1 - alpha[:-1]], 0), 0)
    weight = alpha * transmit                                   # [N, H*W]
    acc = weight.sum(0)
    image = (weight[..., None] * rgb[order, None, :]).sum(0)
    out = [image]
    if render_mode in ("RGB+ED", "ED"):
        out.append(((weight * z[order, None]).sum(0) / acc.clamp_min(1e-6))[:, None])
    renders = torch.cat(out, -1).reshape(1, height, width, -1)
    return renders, acc.reshape(1, height, width, 1), {}


class MCMCStrategy:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def check_sanity(self, params, optimizers):
        assert set(params) == set(optimizers)

    def initialize_state(self):
        return {"binoms": torch.zeros(2)}

    def step_post_backward(self, params, optimizers, state, step, info, lr):
        pass


class DefaultStrategy:
    def __init__(self, refine_start_iter=500, refine_stop_iter=15000, **kwargs):
        self.refine_start_iter, self.refine_stop_iter = refine_start_iter, refine_stop_iter

    def check_sanity(self, params, optimizers):
        assert set(params) == set(optimizers)

    def initialize_state(self, scene_scale=1.0):
        return {"grad2d": None, "count": None, "scene_scale": scene_scale}

    def step_pre_backward(self, params, optimizers, state, step, info):
        pass

    def step_post_backward(self, params, optimizers, state, step, info, packed=False):
        pass


def ssim_loss(a, b):
    return F.mse_loss(a, b)


def depth_to_normal(depths, camtoworlds, Ks):
    _, H, W, _ = depths.shape
    K, c2w = Ks[0], camtoworlds[0]
    ys, xs = torch.meshgrid(torch.arange(H, device=depths.device) + 0.5, torch.arange(W, device=depths.device) + 0.5, indexing="ij")
    rays = torch.stack([(xs - K[0, 2]) / K[0, 0], (ys - K[1, 2]) / K[1, 1], torch.ones_like(xs)], -1)
    points = (rays * depths[0]) @ c2w[:3, :3].T + c2w[:3, 3]
    dx = points[2:, 1:-1] - points[:-2, 1:-1]
    dy = points[1:-1, 2:] - points[1:-1, :-2]
    normal = F.normalize(torch.cross(dx, dy, dim=-1), dim=-1)
    return F.pad(normal.permute(2, 0, 1), (1, 1, 1, 1)).permute(1, 2, 0)[None]


BACKEND = SimpleNamespace(rasterization=rasterization, DefaultStrategy=DefaultStrategy, MCMCStrategy=MCMCStrategy,
                          ssim_loss=ssim_loss, depth_to_normal=depth_to_normal)
